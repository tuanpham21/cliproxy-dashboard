import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { responseAuthPattern, responseLogFilePattern, responseTimestampPattern } from "./logs.js";
import { validateQuotaSnapshotStatePath } from "./paths.js";
import { classifyQuotaWindow, deriveCredentialFingerprint, hasVerifiedCredentialIdentity } from "./rotation-policy.js";
import type { ObservedRoutedAccountRoute } from "./rotation-types.js";
import { atomicWriteOwnerOnlyJson, deriveProxyAccountKey, hasQuotaEvidence, mergeQuotaWindowEvidence, readQuotaSnapshotStoreFile, withQuotaSnapshotStateLock } from "./quota-store.js";
import type { AccountView, DashboardPaths, PersistedQuotaSnapshot, PersistedQuotaSnapshotStore, PersistedQuotaWindowEvidence, QuotaSnapshotUpdate } from "./types.js";
import { normalizeProxyAccountLocalIdentity, normalizeUsedPercent } from "./util.js";

type MergedQuotaSnapshots = {
  snapshotsByCanonicalIdentity: Map<string, PersistedQuotaSnapshot>;
  proxyAccountKeysByCanonicalIdentity: Map<string, string>;
  errors: string[];
};

function emptyMergedQuotaSnapshots(errors: string[] = []): MergedQuotaSnapshots {
  return {
    snapshotsByCanonicalIdentity: new Map(),
    proxyAccountKeysByCanonicalIdentity: new Map(),
    errors,
  };
}

export function parseResponseTimestampMs(lines: string[], fallbackMs: number): number {
  const timestampLine = lines.find((line) => responseTimestampPattern.test(line.trim()));
  const timestamp = timestampLine?.trim().match(responseTimestampPattern)?.groups?.timestamp ?? "";
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

export function getResponseHeaderNumber(lines: string[], name: string): number | undefined {
  const lowerName = name.toLowerCase();
  const line = lines.find((candidate) => candidate.toLowerCase().startsWith(`${lowerName}:`));
  if (!line) {
    return undefined;
  }
  const raw = line.slice(line.indexOf(":") + 1).trim();
  if (raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function epochHeaderToIso(value: number | undefined): string | undefined {
  if (value === undefined || value <= 0) {
    return undefined;
  }
  const epochMs = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(epochMs).toISOString();
}

export function quotaWindowEvidenceFromHeaders(
  lines: string[],
  observedMs: number,
  usedHeader: string,
  resetAfterHeader: string,
  resetAtHeader: string,
): PersistedQuotaWindowEvidence | undefined {
  const usedPercent = normalizeUsedPercent(getResponseHeaderNumber(lines, usedHeader) ?? NaN);
  if (usedPercent === undefined) {
    return undefined;
  }
  const resetAtRaw = getResponseHeaderNumber(lines, resetAtHeader);
  const resetAfterSeconds = getResponseHeaderNumber(lines, resetAfterHeader);
  const resetAt =
    epochHeaderToIso(resetAtRaw) ??
    (resetAfterSeconds === undefined ? undefined : new Date(observedMs + resetAfterSeconds * 1000).toISOString());
  return {
    usedPercent,
    rawUsedPercent: usedPercent,
    ...(resetAt ? { resetAt } : {}),
    observedAt: new Date(observedMs).toISOString(),
    source: "response-header",
  };
}

function getHeaderNumberAny(lines: string[], names: string[]): number | undefined {
  for (const name of names) {
    const value = getResponseHeaderNumber(lines, name);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function durationMinutesFromHeaders(lines: string[], slot: "primary" | "secondary", observedMs: number): number | undefined {
  const prefix = slot === "primary" ? "X-Codex-Primary" : "X-Codex-Secondary";
  const direct = getHeaderNumberAny(lines, [
    `${prefix}-Window-Minutes`,
    `${prefix}-Window-Duration-Minutes`,
    `${prefix}-Limit-Window-Minutes`,
  ]);
  if (direct !== undefined && direct > 0) {
    return direct;
  }
  const seconds = getHeaderNumberAny(lines, [
    `${prefix}-Window-Seconds`,
    `${prefix}-Window-Duration-Seconds`,
  ]);
  if (seconds !== undefined && seconds > 0) {
    return seconds / 60;
  }
  const resetAfterSeconds = getHeaderNumberAny(lines, [
    `${prefix}-Reset-After-Seconds`,
    `${prefix}-Reset-After`,
  ]);
  if (resetAfterSeconds !== undefined && resetAfterSeconds > 0) {
    const minutes = resetAfterSeconds / 60;
    if (Math.abs(minutes - 10080) <= 60) return 10080;
    if (Math.abs(minutes - 300) <= 15) return 300;
    return minutes;
  }
  const resetAtRaw = getResponseHeaderNumber(lines, `${prefix}-Reset-At`);
  if (resetAtRaw !== undefined && resetAtRaw > 0 && observedMs !== undefined) {
    const diffSeconds = resetAtRaw - Math.floor(observedMs / 1000);
    if (diffSeconds > 0) {
      const minutes = diffSeconds / 60;
      if (Math.abs(minutes - 10080) <= 60) return 10080;
      if (Math.abs(minutes - 300) <= 15) return 300;
      return minutes;
    }
  }
  return undefined;
}

function evidenceIdFor(lines: string[], responseId: string, slot: string): string {
  return createHash("sha256")
    .update("cliproxy-dashboard quota-evidence v2\0")
    .update(responseId, "utf8")
    .update("\0" + slot + "\0" + lines.join("\n"), "utf8")
    .digest("base64url");
}

function responseObservationId(lines: string[], responseId: string): string {
  return createHash("sha256")
    .update("cliproxy-dashboard routed-observation v1\0")
    .update(responseId, "utf8")
    .update("\0" + lines.join("\n"), "utf8")
    .digest("base64url");
}

function routeTraceIdFromLines(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = line.trim().match(/^(?:Trace ID|TraceId|X-Client-Request-Id|Request ID):\s*(\S+)$/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function semanticEvidenceForSlot(
  lines: string[],
  observedMs: number,
  responseId: string,
  credentialFingerprint: string,
  slot: "primary" | "secondary",
): PersistedQuotaWindowEvidence | undefined {
  const prefix = slot === "primary" ? "X-Codex-Primary" : "X-Codex-Secondary";
  const usedPercent = normalizeUsedPercent(getResponseHeaderNumber(lines, `${prefix}-Used-Percent`) ?? NaN);
  if (usedPercent === undefined) {
    return undefined;
  }
  const resetAt = epochHeaderToIso(getResponseHeaderNumber(lines, `${prefix}-Reset-At`)) ??
    (() => {
      const resetAfter = getResponseHeaderNumber(lines, `${prefix}-Reset-After-Seconds`);
      return resetAfter === undefined ? undefined : new Date(observedMs + resetAfter * 1000).toISOString();
    })();
  const durationMinutes = durationMinutesFromHeaders(lines, slot, observedMs);
  const windowKind = classifyQuotaWindow(durationMinutes);
  return {
    usedPercent,
    rawUsedPercent: usedPercent,
    ...(resetAt ? { resetAt } : {}),
    observedAt: new Date(observedMs).toISOString(),
    source: "response-header",
    durationMinutes,
    windowKind,
    providerSlot: slot,
    evidenceId: evidenceIdFor(lines, responseId, slot),
    credentialFingerprint,
    continuity: "continuous",
    ...(windowKind === "unknown" ? { migrationOnly: true } : {}),
    schemaVersion: 2,
  };
}

export function parseQuotaResponseEvidence(
  lines: string[],
  observedMs: number,
  responseId: string,
  credentialFingerprint: string,
): {
  weekly?: PersistedQuotaWindowEvidence;
  fiveHour?: PersistedQuotaWindowEvidence;
  legacyPrimary5h?: PersistedQuotaWindowEvidence;
  legacyWeekly?: PersistedQuotaWindowEvidence;
  continuity: "continuous" | "broken" | "uncertain";
} {
  const primary = semanticEvidenceForSlot(lines, observedMs, responseId, credentialFingerprint, "primary");
  const secondary = semanticEvidenceForSlot(lines, observedMs, responseId, credentialFingerprint, "secondary");
  const weekly = [primary, secondary].find((evidence) => evidence?.windowKind === "weekly");
  const fiveHour = [primary, secondary].find((evidence) => evidence?.windowKind === "five-hour");
  const legacyPrimary5h = primary && primary.windowKind === "unknown" ? { ...primary, migrationOnly: true } : undefined;
  const legacyWeekly = secondary && secondary.windowKind === "unknown" ? { ...secondary, migrationOnly: true } : undefined;
  const continuity = weekly || fiveHour ? "continuous" : legacyPrimary5h || legacyWeekly ? "uncertain" : "broken";
  return { weekly, fiveHour, legacyPrimary5h, legacyWeekly, continuity };
}

export async function readResponseHeaderQuotaUpdateFile(
  filePath: string,
  responseId = path.basename(filePath),
  fallbackMtimeMs?: number,
): Promise<QuotaSnapshotUpdate | null> {
  try {
    const [text, fileStats] = await Promise.all([
      readFile(filePath, "utf8"),
      fallbackMtimeMs === undefined ? stat(filePath) : Promise.resolve(null),
    ]);
    const lines = text.split(/\r?\n/);
    const authLine = lines.find((line) => line.trimStart().startsWith("Auth: provider=codex,"));
    const match = authLine ? responseAuthPattern.exec(authLine.trim()) : null;
    if (!match?.groups) return null;
    const observedMs = parseResponseTimestampMs(lines, fallbackMtimeMs ?? fileStats?.mtimeMs ?? Date.now());
    const timestampIsValid = lines.some((line) => {
      const timestamp = line.trim().match(responseTimestampPattern)?.groups?.timestamp;
      return Boolean(timestamp && Number.isFinite(Date.parse(timestamp)));
    });
    const parsed = parseQuotaResponseEvidence(lines, observedMs, responseId, "");
    const primary5h = parsed.fiveHour ?? parsed.legacyPrimary5h;
    const weekly = parsed.weekly ?? parsed.legacyWeekly;
    return {
      canonicalLocalIdentity: normalizeProxyAccountLocalIdentity(match.groups.auth),
      ...(primary5h ? { primary5h } : {}),
      ...(weekly ? { weekly } : {}),
      continuity: timestampIsValid ? parsed.continuity : "broken",
      observationId: responseObservationId(lines, responseId),
      observedAt: new Date(observedMs).toISOString(),
      routeTraceId: routeTraceIdFromLines(lines),
    };
  } catch {
    return null;
  }
}

export async function readResponseHeaderQuotaUpdates(
  logsDir: string,
): Promise<QuotaSnapshotUpdate[]> {
  const updates: QuotaSnapshotUpdate[] = [];
  try {
    await access(logsDir);
  } catch {
    return updates;
  }

  const entries = await readdir(logsDir, { withFileTypes: true });
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  const filesToParse = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && responseLogFilePattern.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(logsDir, entry.name);
        try {
          const stats = await stat(filePath);
          const ageMs = now - stats.mtimeMs;
          if (ageMs <= oneWeekMs) {
            return { name: entry.name, filePath, mtimeMs: stats.mtimeMs };
          }
        } catch {}
        return null;
      }),
  );

  const activeFiles = filesToParse.filter(
    (f): f is { name: string; filePath: string; mtimeMs: number } => f !== null,
  );

  activeFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  for (const file of activeFiles) {
    const update = await readResponseHeaderQuotaUpdateFile(file.filePath, file.name, file.mtimeMs);
    if (update) updates.push(update);
  }

  return updates;
}

export function mergeQuotaSnapshotUpdates(
  store: PersistedQuotaSnapshotStore,
  accounts: AccountView[],
  updates: QuotaSnapshotUpdate[],
  completedRoutes: ObservedRoutedAccountRoute[] = [],
): { snapshotsByCanonicalIdentity: Map<string, PersistedQuotaSnapshot>; proxyAccountKeysByCanonicalIdentity: Map<string, string>; changed: boolean } {
  let changed = false;
  const snapshotsByKey = new Map<string, PersistedQuotaSnapshot>();
  for (const snapshot of store.snapshots) {
    snapshotsByKey.set(snapshot.proxyAccountKey, snapshot);
  }

  const keyByCanonicalIdentity = new Map<string, string>();
  const accountByCanonicalIdentity = new Map<string, AccountView>();
  const fingerprintByCanonicalIdentity = new Map<string, string>();
  const baselineByKey = new Map(store.credentialBaselines.map((baseline) => [baseline.proxyAccountKey, baseline]));
  for (const account of accounts) {
    const canonicalIdentity = normalizeProxyAccountLocalIdentity(account.fileName);
    if (!keyByCanonicalIdentity.has(canonicalIdentity)) {
      const proxyAccountKey = deriveProxyAccountKey(store, canonicalIdentity);
      keyByCanonicalIdentity.set(canonicalIdentity, proxyAccountKey);
      accountByCanonicalIdentity.set(canonicalIdentity, account);
      if (hasVerifiedCredentialIdentity(account.raw)) {
        const credentialFingerprint = deriveCredentialFingerprint(store.keyDerivation.secret, account.fileName, account.raw);
        fingerprintByCanonicalIdentity.set(canonicalIdentity, credentialFingerprint);
        const currentEvidenceMs = updates
          .filter((update) => update.canonicalLocalIdentity === canonicalIdentity)
          .flatMap((update) => [update.primary5h?.observedAt, update.weekly?.observedAt])
          .filter((value): value is string => Boolean(value))
          .map((observedAt) => Date.parse(observedAt))
          .filter((ms) => Number.isFinite(ms));
        const establishedMs = currentEvidenceMs.length > 0 ? Math.min(Date.now(), ...currentEvidenceMs) : Date.now();
        const currentEvidenceIds = updates
          .filter((update) => update.canonicalLocalIdentity === canonicalIdentity)
          .flatMap((update) => [update.primary5h?.evidenceId, update.weekly?.evidenceId])
          .filter((value): value is string => Boolean(value));
        const baseline = baselineByKey.get(proxyAccountKey);
        if (!baseline || baseline.credentialFingerprint !== credentialFingerprint) {
          baselineByKey.set(proxyAccountKey, {
            proxyAccountKey,
            credentialFingerprint,
            establishedAt: new Date(establishedMs).toISOString(),
            seenEvidenceIds: [],
          });
          const snapshot = snapshotsByKey.get(proxyAccountKey);
          if (snapshot?.credentialFingerprint && snapshot.credentialFingerprint !== credentialFingerprint) {
            snapshot.identityMismatch = true;
            snapshot.observationContinuity = "broken";
          }
          changed = true;
        }
      }
    }
  }

  for (const update of updates) {
    const proxyAccountKey = keyByCanonicalIdentity.get(update.canonicalLocalIdentity);
    if (!proxyAccountKey) {
      continue;
    }
    let snapshot = snapshotsByKey.get(proxyAccountKey);
    if (!snapshot) {
      snapshot = { proxyAccountKey };
      snapshotsByKey.set(proxyAccountKey, snapshot);
      changed = true;
    }
    const credentialFingerprint = fingerprintByCanonicalIdentity.get(update.canonicalLocalIdentity) ?? "";
    const baseline = baselineByKey.get(proxyAccountKey);
    const bindEvidence = (evidence: PersistedQuotaWindowEvidence | undefined): PersistedQuotaWindowEvidence | undefined => {
      if (!evidence) return undefined;
      if (evidence.migrationOnly) {
        return {
          ...(evidence.usedPercent === undefined ? {} : { usedPercent: evidence.usedPercent }),
          ...(evidence.rawUsedPercent === undefined ? {} : { rawUsedPercent: evidence.rawUsedPercent }),
          ...(evidence.resetAt ? { resetAt: evidence.resetAt } : {}),
          observedAt: evidence.observedAt,
          source: evidence.source,
          ...(evidence.debugStatus === undefined ? {} : { debugStatus: evidence.debugStatus }),
          ...(evidence.durationMinutes === undefined ? {} : { durationMinutes: evidence.durationMinutes }),
          ...(evidence.windowKind === undefined ? {} : { windowKind: evidence.windowKind }),
          ...(evidence.providerSlot === undefined ? {} : { providerSlot: evidence.providerSlot }),
          ...(evidence.continuity === undefined ? {} : { continuity: evidence.continuity }),
          migrationOnly: true,
          ...(evidence.schemaVersion === undefined ? {} : { schemaVersion: evidence.schemaVersion }),
        };
      }
      const evidenceObservedMs = Date.parse(evidence.observedAt);
      const baselineMs = baseline ? Date.parse(baseline.establishedAt) : NaN;
      const canBindCurrentCredential = Boolean(
        credentialFingerprint &&
        baseline?.credentialFingerprint === credentialFingerprint &&
        evidence.evidenceId &&
        !baseline.seenEvidenceIds.includes(evidence.evidenceId) &&
        Number.isFinite(evidenceObservedMs) &&
        Number.isFinite(baselineMs) &&
        evidenceObservedMs >= baselineMs,
      );
      return evidence.credentialFingerprint
        ? evidence
        : canBindCurrentCredential
          ? { ...evidence, credentialFingerprint }
          : (() => {
              const { credentialFingerprint: _ignored, ...unbound } = evidence;
              return unbound;
            })();
    };
    let semanticEvidenceAccepted = false;
    let boundSemanticEvidenceAccepted = false;
    let unboundSemanticEvidenceAccepted = false;
    for (const windowName of ["primary5h", "weekly"] as const) {
      const evidence = bindEvidence(update[windowName]);
      const current = snapshot[windowName];
      if (current?.credentialFingerprint && credentialFingerprint && current.credentialFingerprint !== credentialFingerprint) {
        if (evidence?.evidenceId && current.evidenceId === evidence.evidenceId) {
          snapshot.identityMismatch = true;
          snapshot.observationContinuity = "broken";
          changed = true;
          continue;
        }
        delete snapshot[windowName];
        changed = true;
      }
      const mergedEvidence = mergeQuotaWindowEvidence(snapshot, windowName, evidence);
      changed = mergedEvidence || changed;
      const semanticMerged = Boolean(mergedEvidence && evidence?.windowKind && evidence.windowKind !== "unknown");
      semanticEvidenceAccepted = semanticEvidenceAccepted || semanticMerged;
      boundSemanticEvidenceAccepted = boundSemanticEvidenceAccepted || Boolean(semanticMerged && evidence?.credentialFingerprint);
      unboundSemanticEvidenceAccepted = unboundSemanticEvidenceAccepted || Boolean(semanticMerged && !evidence?.credentialFingerprint);
      if (evidence?.evidenceId && baseline && !baseline.seenEvidenceIds.includes(evidence.evidenceId)) {
        baseline.seenEvidenceIds = [...baseline.seenEvidenceIds, evidence.evidenceId].slice(-256);
        changed = true;
      }
    }
    const continuityToRecord = unboundSemanticEvidenceAccepted
      ? "broken"
      : update.continuity === "uncertain" && snapshot.credentialFingerprint
      ? "broken"
      : update.continuity;
    const tracksRotationContinuity = semanticEvidenceAccepted || continuityToRecord === "broken";
    const updateObservedMs = update.observedAt ? Date.parse(update.observedAt) : 0;
    const currentObservedMs = snapshot.lastObservationAt ? Date.parse(snapshot.lastObservationAt) : 0;
    if (tracksRotationContinuity && updateObservedMs >= currentObservedMs) {
      if (continuityToRecord !== "uncertain" && snapshot.observationContinuity !== continuityToRecord) {
        snapshot.observationContinuity = continuityToRecord;
        changed = true;
      }
      if (update.observationId && snapshot.lastObservationId !== update.observationId) {
        snapshot.lastObservationId = update.observationId;
        changed = true;
      }
      if (update.observedAt && snapshot.lastObservationAt !== update.observedAt) {
        snapshot.lastObservationAt = update.observedAt;
        changed = true;
      }
    }
    if (boundSemanticEvidenceAccepted && credentialFingerprint) {
      const identityChanged = snapshot.credentialFingerprint !== credentialFingerprint || snapshot.identityMismatch;
      if (identityChanged) {
        snapshot.credentialFingerprint = credentialFingerprint;
        delete snapshot.identityMismatch;
        changed = true;
      }
      if ((identityChanged || !snapshot.continuityStartedAt) && update.observedAt) {
        snapshot.continuityStartedAt = update.observedAt;
        changed = true;
      }
    }
  }

  store.credentialBaselines = [...baselineByKey.values()].sort((left, right) => left.proxyAccountKey.localeCompare(right.proxyAccountKey));

  for (const [canonicalIdentity, proxyAccountKey] of keyByCanonicalIdentity) {
    const snapshot = snapshotsByKey.get(proxyAccountKey);
    const account = accountByCanonicalIdentity.get(canonicalIdentity);
    if (!snapshot?.credentialFingerprint || !account) continue;
    if (!hasVerifiedCredentialIdentity(account.raw)) {
      if (!snapshot.identityMismatch || snapshot.observationContinuity !== "broken") {
        snapshot.identityMismatch = true;
        snapshot.observationContinuity = "broken";
        changed = true;
      }
      continue;
    }
    const currentFingerprint = deriveCredentialFingerprint(store.keyDerivation.secret, account.fileName, account.raw);
    if (currentFingerprint !== snapshot.credentialFingerprint) {
      if (!snapshot.identityMismatch || snapshot.observationContinuity !== "broken") {
        snapshot.identityMismatch = true;
        snapshot.observationContinuity = "broken";
        changed = true;
      }
    }
  }

  const matchedRouteKeys = new Set(
    updates
      .filter((update) => update.routeTraceId)
      .map((update) => `${update.canonicalLocalIdentity}\0${update.routeTraceId}`),
  );
  for (const route of completedRoutes) {
    if (matchedRouteKeys.has(`${route.canonicalLocalIdentity}\0${route.traceId}`)) continue;
    const proxyAccountKey = keyByCanonicalIdentity.get(route.canonicalLocalIdentity);
    const snapshot = proxyAccountKey ? snapshotsByKey.get(proxyAccountKey) : undefined;
    if (!snapshot?.credentialFingerprint) continue;
    const authorityStartMs = snapshot.continuityStartedAt ? Date.parse(snapshot.continuityStartedAt) : NaN;
    const routedMs = Date.parse(route.observedAt);
    if (!Number.isFinite(authorityStartMs) || !Number.isFinite(routedMs) || routedMs < authorityStartMs) continue;
    snapshot.observationContinuity = "broken";
    if (!snapshot.lastObservationAt || routedMs > Date.parse(snapshot.lastObservationAt)) {
      snapshot.lastObservationAt = new Date(routedMs).toISOString();
      snapshot.lastObservationId = `route_${route.traceId}`;
    }
    changed = true;
  }

  store.snapshots = [...snapshotsByKey.values()]
    .filter(hasQuotaEvidence)
    .sort((left, right) => left.proxyAccountKey.localeCompare(right.proxyAccountKey));

  const snapshotsByCanonicalIdentity = new Map<string, PersistedQuotaSnapshot>();
  for (const [canonicalIdentity, proxyAccountKey] of keyByCanonicalIdentity) {
    const snapshot = snapshotsByKey.get(proxyAccountKey);
    if (snapshot && hasQuotaEvidence(snapshot)) {
      snapshotsByCanonicalIdentity.set(canonicalIdentity, snapshot);
    }
  }
  return { snapshotsByCanonicalIdentity, proxyAccountKeysByCanonicalIdentity: keyByCanonicalIdentity, changed };
}

export async function readMergedQuotaSnapshots(
  paths: DashboardPaths,
  accounts: AccountView[],
  beforeWrite?: () => Promise<void> | void,
  completedRoutes: ObservedRoutedAccountRoute[] = [],
  readOnly = true,
): Promise<MergedQuotaSnapshots> {
  const updates = await readResponseHeaderQuotaUpdates(paths.logsDir);
  return await mergeObservedQuotaUpdates(paths, accounts, updates, completedRoutes, beforeWrite, readOnly);
}

export async function mergeObservedQuotaUpdates(
  paths: DashboardPaths,
  accounts: AccountView[],
  updates: QuotaSnapshotUpdate[],
  completedRoutes: ObservedRoutedAccountRoute[] = [],
  beforeWrite?: () => Promise<void> | void,
  readOnly = false,
): Promise<MergedQuotaSnapshots> {
  const stateFilePath = paths.quotaSnapshotStatePath;

  try {
    await validateQuotaSnapshotStatePath(stateFilePath, paths.authDir, paths.configPath);
    const runMerge = async () => {
      const { store, error, dirty, initialized } = await readQuotaSnapshotStoreFile(stateFilePath);
      if (readOnly && initialized) {
        return emptyMergedQuotaSnapshots(error ? [error] : []);
      }
      const merged = mergeQuotaSnapshotUpdates(store, accounts, updates, completedRoutes);
      if (!readOnly && (dirty || merged.changed)) {
        await beforeWrite?.();
        await atomicWriteOwnerOnlyJson(stateFilePath, store);
      }
      return {
        snapshotsByCanonicalIdentity: merged.snapshotsByCanonicalIdentity,
        proxyAccountKeysByCanonicalIdentity: merged.proxyAccountKeysByCanonicalIdentity,
        errors: error ? [error] : [],
      };
    };
    return readOnly ? await runMerge() : await withQuotaSnapshotStateLock(stateFilePath, runMerge);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return emptyMergedQuotaSnapshots([`Quota snapshot state store unavailable: ${message}`]);
  }
}
