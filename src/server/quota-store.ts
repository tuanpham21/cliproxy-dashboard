import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { QUOTA_SNAPSHOT_SCHEMA_VERSION } from "./constants.js";
import { isEnoent } from "./paths.js";
import type { PersistedQuotaSnapshot, PersistedQuotaSnapshotStore, PersistedQuotaWindowEvidence, QuotaWindowName } from "./types.js";
import { evidenceIsNewer, isRecord, normalizeUsedPercent } from "./util.js";

export function createEmptyQuotaSnapshotStore(): PersistedQuotaSnapshotStore {
  return {
    schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION,
    keyDerivation: {
      algorithm: "hmac-sha256",
      secret: randomBytes(32).toString("base64url"),
      keyPrefix: "pak_v1",
    },
    snapshots: [],
  };
}

export function normalizeQuotaEvidence(raw: unknown): PersistedQuotaWindowEvidence | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const source = raw.source === "identity-bound-read" ? "identity-bound-read" : raw.source === "response-header" ? "response-header" : undefined;
  const observedAt = typeof raw.observedAt === "string" && Number.isFinite(Date.parse(raw.observedAt))
    ? new Date(Date.parse(raw.observedAt)).toISOString()
    : "";
  if (!source || !observedAt) {
    return undefined;
  }
  const usedPercent =
    typeof raw.usedPercent === "number" ? normalizeUsedPercent(raw.usedPercent) : undefined;
  const resetAt =
    typeof raw.resetAt === "string" && Number.isFinite(Date.parse(raw.resetAt))
      ? new Date(Date.parse(raw.resetAt)).toISOString()
      : undefined;
  const debugStatus =
    typeof raw.debugStatus === "string" && raw.debugStatus.length <= 80 ? raw.debugStatus : undefined;
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetAt === undefined ? {} : { resetAt }),
    observedAt,
    source,
    ...(debugStatus === undefined ? {} : { debugStatus }),
  };
}

export function quotaEvidenceWasSanitized(
  raw: unknown,
  normalized: PersistedQuotaWindowEvidence | undefined,
): boolean {
  if (!isRecord(raw)) {
    return normalized !== undefined;
  }
  const allowedEvidenceKeys = new Set(["usedPercent", "resetAt", "observedAt", "source", "debugStatus"]);
  for (const key of Object.keys(raw)) {
    if (!allowedEvidenceKeys.has(key)) {
      return true;
    }
  }
  if (!normalized) {
    return true;
  }
  if ("usedPercent" in raw) {
    if (typeof raw.usedPercent !== "number") {
      return true;
    }
    if (normalizeUsedPercent(raw.usedPercent) !== normalized.usedPercent) {
      return true;
    }
  }
  if ("resetAt" in raw && typeof raw.resetAt !== "string") {
    return true;
  }
  if (typeof raw.resetAt === "string") {
    const parsedResetAt = Date.parse(raw.resetAt);
    const canonicalResetAt = Number.isFinite(parsedResetAt) ? new Date(parsedResetAt).toISOString() : undefined;
    if (canonicalResetAt !== normalized.resetAt) {
      return true;
    }
  }
  const parsedObservedAt = typeof raw.observedAt === "string" ? Date.parse(raw.observedAt) : NaN;
  if (!Number.isFinite(parsedObservedAt) || new Date(parsedObservedAt).toISOString() !== normalized.observedAt) {
    return true;
  }
  if (raw.source !== normalized.source) {
    return true;
  }
  if (typeof raw.debugStatus === "string" && raw.debugStatus.length <= 80) {
    return raw.debugStatus !== normalized.debugStatus;
  }
  return raw.debugStatus !== undefined;
}

export function normalizePersistedQuotaSnapshotStore(
  raw: unknown,
): { store: PersistedQuotaSnapshotStore; dirty: boolean } | null {
  if (!isRecord(raw) || raw.schemaVersion !== QUOTA_SNAPSHOT_SCHEMA_VERSION) {
    return null;
  }
  let dirty = false;
  const allowedRootKeys = new Set(["schemaVersion", "keyDerivation", "snapshots"]);
  for (const key of Object.keys(raw)) {
    if (!allowedRootKeys.has(key)) {
      dirty = true;
    }
  }
  const keyDerivation = isRecord(raw.keyDerivation) ? raw.keyDerivation : null;
  const secret = typeof keyDerivation?.secret === "string" ? keyDerivation.secret : "";
  if (keyDerivation) {
    const allowedKeyDerivationKeys = new Set(["algorithm", "secret", "keyPrefix"]);
    for (const key of Object.keys(keyDerivation)) {
      if (!allowedKeyDerivationKeys.has(key)) {
        dirty = true;
      }
    }
  }
  if (
    keyDerivation?.algorithm !== "hmac-sha256" ||
    keyDerivation?.keyPrefix !== "pak_v1" ||
    !/^[A-Za-z0-9_-]{32,}$/.test(secret)
  ) {
    return null;
  }

  const snapshots: PersistedQuotaSnapshot[] = [];
  const rawSnapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  for (const rawSnapshot of rawSnapshots) {
    if (!isRecord(rawSnapshot) || typeof rawSnapshot.proxyAccountKey !== "string") {
      dirty = true;
      continue;
    }
    const allowedSnapshotKeys = new Set(["proxyAccountKey", "primary5h", "weekly"]);
    for (const key of Object.keys(rawSnapshot)) {
      if (!allowedSnapshotKeys.has(key)) {
        dirty = true;
      }
    }
    if (!/^pak_v1_[A-Za-z0-9_-]{32,}$/.test(rawSnapshot.proxyAccountKey)) {
      dirty = true;
      continue;
    }
    const primary5h = normalizeQuotaEvidence(rawSnapshot.primary5h);
    const weekly = normalizeQuotaEvidence(rawSnapshot.weekly);
    if (!primary5h && !weekly) {
      dirty = true;
      continue;
    }
    if (rawSnapshot.primary5h !== undefined) {
      dirty = quotaEvidenceWasSanitized(rawSnapshot.primary5h, primary5h) || dirty;
    }
    if (rawSnapshot.weekly !== undefined) {
      dirty = quotaEvidenceWasSanitized(rawSnapshot.weekly, weekly) || dirty;
    }
    snapshots.push({
      proxyAccountKey: rawSnapshot.proxyAccountKey,
      ...(primary5h ? { primary5h } : {}),
      ...(weekly ? { weekly } : {}),
    });
  }

  return {
    store: {
      schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION,
      keyDerivation: {
        algorithm: "hmac-sha256",
        secret,
        keyPrefix: "pak_v1",
      },
      snapshots,
    },
    dirty,
  };
}

export async function readQuotaSnapshotStoreFile(
  stateFilePath: string,
): Promise<{ store: PersistedQuotaSnapshotStore; error?: string; dirty: boolean }> {
  try {
    const text = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    const normalized = normalizePersistedQuotaSnapshotStore(parsed);
    if (!normalized) {
      return {
        store: createEmptyQuotaSnapshotStore(),
        error: "Quota snapshot state file was invalid and was reinitialized",
        dirty: true,
      };
    }
    return { store: normalized.store, dirty: normalized.dirty };
  } catch (error) {
    if (isEnoent(error)) {
      return { store: createEmptyQuotaSnapshotStore(), dirty: true };
    }
    return {
      store: createEmptyQuotaSnapshotStore(),
      error: "Quota snapshot state file could not be read and was reinitialized",
      dirty: true,
    };
  }
}

export async function atomicWriteOwnerOnlyJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(tempPath, 0o600);
    } catch {}
    await rename(tempPath, filePath);
    try {
      await chmod(filePath, 0o600);
    } catch {}
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {}
    throw error;
  }
}

export const quotaSnapshotStateLocks = new Map<string, Promise<void>>();

export async function withQuotaSnapshotStateLock<T>(stateFilePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(stateFilePath);
  const previous = quotaSnapshotStateLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const next = current.then(
    () => undefined,
    () => undefined,
  );
  quotaSnapshotStateLocks.set(key, next);
  try {
    return await current;
  } finally {
    if (quotaSnapshotStateLocks.get(key) === next) {
      quotaSnapshotStateLocks.delete(key);
    }
  }
}

export function deriveProxyAccountKey(store: PersistedQuotaSnapshotStore, canonicalLocalIdentity: string): string {
  const digest = createHmac("sha256", Buffer.from(store.keyDerivation.secret, "base64url"))
    .update("cliproxy-dashboard proxy-account-key v1\0")
    .update(canonicalLocalIdentity, "utf8")
    .digest("base64url");
  return `${store.keyDerivation.keyPrefix}_${digest}`;
}

export function mergeQuotaWindowEvidence(
  snapshot: PersistedQuotaSnapshot,
  windowName: QuotaWindowName,
  evidence: PersistedQuotaWindowEvidence | undefined,
): boolean {
  if (!evidence) {
    return false;
  }
  const current = snapshot[windowName];
  if (!evidenceIsNewer(evidence, current)) {
    return false;
  }
  snapshot[windowName] = evidence;
  return true;
}

export function hasQuotaEvidence(snapshot: PersistedQuotaSnapshot): boolean {
  return Boolean(snapshot.primary5h || snapshot.weekly);
}
