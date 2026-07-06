import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { responseAuthPattern, responseLogFilePattern, responseTimestampPattern } from "./logs.js";
import { validateQuotaSnapshotStatePath } from "./paths.js";
import { atomicWriteOwnerOnlyJson, createEmptyQuotaSnapshotStore, deriveProxyAccountKey, hasQuotaEvidence, mergeQuotaWindowEvidence, readQuotaSnapshotStoreFile, withQuotaSnapshotStateLock } from "./quota-store.js";
import type { AccountView, DashboardPaths, PersistedQuotaSnapshot, PersistedQuotaSnapshotStore, PersistedQuotaWindowEvidence, QuotaSnapshotUpdate } from "./types.js";
import { normalizeProxyAccountLocalIdentity, normalizeUsedPercent } from "./util.js";

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
  const value = Number(line.slice(line.indexOf(":") + 1).trim());
  return Number.isFinite(value) ? value : undefined;
}

export function epochHeaderToIso(value: number | undefined): string | undefined {
  if (value === undefined || value < 0) {
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
    ...(resetAt ? { resetAt } : {}),
    observedAt: new Date(observedMs).toISOString(),
    source: "response-header",
  };
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
    try {
      const text = await readFile(file.filePath, "utf8");
      const lines = text.split(/\r?\n/);
      const authLine = lines.find((line) => line.trimStart().startsWith("Auth: provider=codex,"));
      if (!authLine) {
        continue;
      }
      const match = responseAuthPattern.exec(authLine.trim());
      if (!match?.groups) {
        continue;
      }
      const observedMs = parseResponseTimestampMs(lines, file.mtimeMs);
      const primary5h = quotaWindowEvidenceFromHeaders(
        lines,
        observedMs,
        "X-Codex-Primary-Used-Percent",
        "X-Codex-Primary-Reset-After-Seconds",
        "X-Codex-Primary-Reset-At",
      );
      const weekly = quotaWindowEvidenceFromHeaders(
        lines,
        observedMs,
        "X-Codex-Secondary-Used-Percent",
        "X-Codex-Secondary-Reset-After-Seconds",
        "X-Codex-Secondary-Reset-At",
      );
      if (!primary5h && !weekly) {
        continue;
      }
      updates.push({
        canonicalLocalIdentity: normalizeProxyAccountLocalIdentity(match.groups.auth),
        ...(primary5h ? { primary5h } : {}),
        ...(weekly ? { weekly } : {}),
      });
    } catch {}
  }

  return updates;
}

export function mergeQuotaSnapshotUpdates(
  store: PersistedQuotaSnapshotStore,
  accounts: AccountView[],
  updates: QuotaSnapshotUpdate[],
): { snapshotsByCanonicalIdentity: Map<string, PersistedQuotaSnapshot>; changed: boolean } {
  let changed = false;
  const snapshotsByKey = new Map<string, PersistedQuotaSnapshot>();
  for (const snapshot of store.snapshots) {
    snapshotsByKey.set(snapshot.proxyAccountKey, snapshot);
  }

  const keyByCanonicalIdentity = new Map<string, string>();
  for (const account of accounts) {
    const canonicalIdentity = normalizeProxyAccountLocalIdentity(account.fileName);
    if (!keyByCanonicalIdentity.has(canonicalIdentity)) {
      keyByCanonicalIdentity.set(canonicalIdentity, deriveProxyAccountKey(store, canonicalIdentity));
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
    changed = mergeQuotaWindowEvidence(snapshot, "primary5h", update.primary5h) || changed;
    changed = mergeQuotaWindowEvidence(snapshot, "weekly", update.weekly) || changed;
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
  return { snapshotsByCanonicalIdentity, changed };
}

export async function readMergedQuotaSnapshots(
  paths: DashboardPaths,
  accounts: AccountView[],
  beforeWrite?: () => Promise<void> | void,
): Promise<{ snapshotsByCanonicalIdentity: Map<string, PersistedQuotaSnapshot>; errors: string[] }> {
  const updates = await readResponseHeaderQuotaUpdates(paths.logsDir);
  const stateFilePath = paths.quotaSnapshotStatePath;

  try {
    return await withQuotaSnapshotStateLock(stateFilePath, async () => {
      await validateQuotaSnapshotStatePath(stateFilePath, paths.authDir, paths.configPath);
      const { store, error, dirty } = await readQuotaSnapshotStoreFile(stateFilePath);
      const merged = mergeQuotaSnapshotUpdates(store, accounts, updates);
      if (dirty || merged.changed) {
        await beforeWrite?.();
        await atomicWriteOwnerOnlyJson(stateFilePath, store);
      }
      return {
        snapshotsByCanonicalIdentity: merged.snapshotsByCanonicalIdentity,
        errors: error ? [error] : [],
      };
    });
  } catch (error) {
    const store = createEmptyQuotaSnapshotStore();
    const merged = mergeQuotaSnapshotUpdates(store, accounts, updates);
    const message = error instanceof Error ? error.message : String(error);
    return {
      snapshotsByCanonicalIdentity: merged.snapshotsByCanonicalIdentity,
      errors: [`Quota snapshot state store unavailable: ${message}`],
    };
  }
}
