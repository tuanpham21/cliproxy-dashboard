import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { readAccounts } from "./accounts.js";
import { atomicWriteText } from "./files.js";
import { parseCompletedCodexRoutes, responseLogFilePattern } from "./logs.js";
import { resolveDashboardPaths } from "./paths.js";
import { mergeObservedQuotaUpdates, readResponseHeaderQuotaUpdateFile } from "./quota-log-updates.js";
import type { ObservedRoutedAccountRoute } from "./rotation-types.js";
import type { DashboardOptions, DashboardPaths, PersistedQuotaSnapshot, QuotaSnapshotUpdate } from "./types.js";
import { normalizeProxyAccountLocalIdentity } from "./util.js";

type ResponseFileCursor = {
  size: number;
  mtimeMs: number;
  observationId?: string;
};

type RotationObserverCursor = {
  schemaVersion: 1;
  responseFiles: Record<string, ResponseFileCursor>;
  mainLogSize: number;
  seenObservationIds: string[];
  seenRouteTraceIds: string[];
  lastErrorFingerprint?: string;
  updatedAt: string;
};

export type RotationObservationBatch = {
  updates: QuotaSnapshotUpdate[];
  completedRoutes: ObservedRoutedAccountRoute[];
  snapshotsByCanonicalIdentity: Map<string, PersistedQuotaSnapshot>;
  errors: string[];
  observedAt: string;
};

export type RotationLogObserverOptions = {
  statePath?: string;
  debounceMs?: number;
  reconcileMs?: number;
  startupOverlapBytes?: number;
  mainLogOverlapBytes?: number;
  maxMainLogReadBytes?: number;
  maxResponseFileBytes?: number;
  maxFilesPerScan?: number;
  maxTrackedFiles?: number;
  maxSeenIds?: number;
  onObservation?: (batch: RotationObservationBatch) => Promise<void> | void;
};

const DEFAULT_DEBOUNCE_MS = 150;
const DEFAULT_RECONCILE_MS = 30_000;
const DEFAULT_OVERLAP_BYTES = 64 * 1024;
const DEFAULT_MAX_MAIN_LOG_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_FILE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_FILES_PER_SCAN = 64;
const DEFAULT_MAX_TRACKED_FILES = 256;
const DEFAULT_MAX_SEEN_IDS = 1024;

function emptyCursor(): RotationObserverCursor {
  return {
    schemaVersion: 1,
    responseFiles: {},
    mainLogSize: 0,
    seenObservationIds: [],
    seenRouteTraceIds: [],
    updatedAt: new Date(0).toISOString(),
  };
}

function isCursor(value: unknown): value is RotationObserverCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Partial<RotationObserverCursor>;
  if (cursor.schemaVersion !== 1 || !cursor.responseFiles || typeof cursor.responseFiles !== "object" || Array.isArray(cursor.responseFiles)) return false;
  if (!Number.isSafeInteger(cursor.mainLogSize) || (cursor.mainLogSize ?? -1) < 0) return false;
  if (!Array.isArray(cursor.seenObservationIds) || !cursor.seenObservationIds.every((value) => typeof value === "string")) return false;
  if (!Array.isArray(cursor.seenRouteTraceIds) || !cursor.seenRouteTraceIds.every((value) => typeof value === "string")) return false;
  if (cursor.lastErrorFingerprint !== undefined && typeof cursor.lastErrorFingerprint !== "string") return false;
  return Object.values(cursor.responseFiles).every((entry) => Boolean(
    entry
      && Number.isSafeInteger(entry.size)
      && entry.size >= 0
      && Number.isFinite(entry.mtimeMs)
      && entry.mtimeMs >= 0
      && (entry.observationId === undefined || typeof entry.observationId === "string"),
  ));
}

async function readCursor(statePath: string): Promise<RotationObserverCursor> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    return isCursor(parsed) ? parsed : emptyCursor();
  } catch {
    return emptyCursor();
  }
}

function boundedAppend(values: string[], additions: string[], limit: number): string[] {
  return [...new Set([...values, ...additions])].slice(-limit);
}

function errorFingerprint(errors: string[]): string | undefined {
  if (errors.length === 0) return undefined;
  return createHash("sha256").update(errors.join("\0"), "utf8").digest("base64url");
}

async function readBoundedMainLog(
  mainLogPath: string,
  previousSize: number,
  startup: boolean,
  overlapBytes: number,
  maxReadBytes: number,
): Promise<{ size: number; routes: ObservedRoutedAccountRoute[]; overflow: boolean }> {
  try {
    const fileStats = await stat(mainLogPath);
    const size = fileStats.size;
    const baseStart = startup || size < previousSize
      ? Math.max(0, size - overlapBytes)
      : Math.max(0, Math.min(previousSize, size) - overlapBytes);
    const start = Math.max(baseStart, size - maxReadBytes);
    const overflow = start > baseStart;
    const length = size - start;
    if (length <= 0) return { size, routes: [], overflow };
    const handle = await open(mainLogPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      let text = buffer.toString("utf8");
      if (start > 0) {
        const firstNewline = text.indexOf("\n");
        text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
      }
      const routes = parseCompletedCodexRoutes(text.split(/\r?\n/)).flatMap((route) => {
        const observedMs = Date.parse(route.observedAt);
        if (!Number.isFinite(observedMs)) return [];
        return [{
          canonicalLocalIdentity: normalizeProxyAccountLocalIdentity(path.basename(route.auth)),
          observedAt: new Date(observedMs).toISOString(),
          traceId: route.traceId,
        }];
      });
      return { size, routes, overflow };
    } finally {
      await handle.close();
    }
  } catch {
    return { size: 0, routes: [], overflow: false };
  }
}

export class RotationLogObserver {
  readonly #paths: DashboardPaths;
  readonly #statePath: string;
  readonly #options: Required<Omit<RotationLogObserverOptions, "statePath" | "onObservation">> & Pick<RotationLogObserverOptions, "onObservation">;
  #cursor: RotationObserverCursor;
  #watcher?: FSWatcher;
  #debounceTimer?: ReturnType<typeof setTimeout>;
  #reconcileTimer?: ReturnType<typeof setInterval>;
  #lock: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(paths: DashboardPaths, statePath: string, cursor: RotationObserverCursor, options: RotationLogObserverOptions) {
    this.#paths = paths;
    this.#statePath = statePath;
    this.#cursor = cursor;
    this.#options = {
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      reconcileMs: options.reconcileMs ?? DEFAULT_RECONCILE_MS,
      startupOverlapBytes: options.startupOverlapBytes ?? DEFAULT_OVERLAP_BYTES,
      mainLogOverlapBytes: options.mainLogOverlapBytes ?? DEFAULT_OVERLAP_BYTES,
      maxMainLogReadBytes: options.maxMainLogReadBytes ?? DEFAULT_MAX_MAIN_LOG_BYTES,
      maxResponseFileBytes: options.maxResponseFileBytes ?? DEFAULT_MAX_RESPONSE_FILE_BYTES,
      maxFilesPerScan: options.maxFilesPerScan ?? DEFAULT_MAX_FILES_PER_SCAN,
      maxTrackedFiles: options.maxTrackedFiles ?? DEFAULT_MAX_TRACKED_FILES,
      maxSeenIds: options.maxSeenIds ?? DEFAULT_MAX_SEEN_IDS,
      onObservation: options.onObservation,
    };
  }

  async start(): Promise<void> {
    if (this.#closed || this.#watcher) return;
    await mkdir(this.#paths.logsDir, { recursive: true });
    await this.reconcile(true);
    this.#watcher = watch(this.#paths.logsDir, () => { this.#scheduleReconcile(); });
    this.#watcher.on("error", () => undefined);
    this.#reconcileTimer = setInterval(() => { void this.reconcile(); }, this.#options.reconcileMs);
    this.#reconcileTimer.unref?.();
  }

  async reconcile(startup = false): Promise<RotationObservationBatch | null> {
    if (this.#closed) return null;
    let result: RotationObservationBatch | null = null;
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      result = await this.#scan(startup);
      return result;
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#reconcileTimer) clearInterval(this.#reconcileTimer);
    this.#watcher?.close();
    await this.#lock;
  }

  #scheduleReconcile(): void {
    if (this.#closed) return;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.#debounceTimer = setTimeout(() => { void this.reconcile(); }, this.#options.debounceMs);
    this.#debounceTimer.unref?.();
  }

  async #scan(startup: boolean): Promise<RotationObservationBatch | null> {
    const nextCursor = structuredClone(this.#cursor);
    const errors: string[] = [];
    const seenObservationIds = new Set(this.#cursor.seenObservationIds);
    const seenRouteTraceIds = new Set(this.#cursor.seenRouteTraceIds);
    const responseFiles: Array<{ name: string; filePath: string; size: number; mtimeMs: number }> = [];
    let responseScanSucceeded = true;
    try {
      const entries = await readdir(this.#paths.logsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !responseLogFilePattern.test(entry.name)) continue;
        const filePath = path.join(this.#paths.logsDir, entry.name);
        try {
          const fileStats = await stat(filePath);
          responseFiles.push({ name: entry.name, filePath, size: fileStats.size, mtimeMs: fileStats.mtimeMs });
        } catch {}
      }
    } catch (error) {
      responseScanSucceeded = false;
      errors.push(`Rotation observation log scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    responseFiles.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    if (responseFiles.length > this.#options.maxTrackedFiles) {
      errors.push(`Rotation response log cursor overflow: ${responseFiles.length} files exceeds ${this.#options.maxTrackedFiles}`);
    }
    const tracked = responseFiles.slice(0, this.#options.maxTrackedFiles);
    const selected: typeof tracked = [];
    let startupBytes = 0;
    for (const file of tracked) {
      const previous = this.#cursor.responseFiles[file.name];
      const changed = !previous || previous.size !== file.size || previous.mtimeMs !== file.mtimeMs;
      const withinStartupOverlap = startup && startupBytes < this.#options.startupOverlapBytes;
      if ((changed || withinStartupOverlap) && selected.length < this.#options.maxFilesPerScan) selected.push(file);
      if (withinStartupOverlap) startupBytes += file.size;
    }
    const selectedNames = new Set(selected.map((file) => file.name));

    const updates: QuotaSnapshotUpdate[] = [];
    const observationIdByFile = new Map<string, string>();
    for (const file of selected) {
      if (file.size > this.#options.maxResponseFileBytes) {
        errors.push(`Rotation response log exceeds bounded read limit: ${file.name}`);
        continue;
      }
      const parsed = await readResponseHeaderQuotaUpdateFile(file.filePath, file.name, file.mtimeMs);
      if (!parsed?.observationId) continue;
      observationIdByFile.set(file.name, parsed.observationId);
      if (this.#cursor.responseFiles[file.name]?.observationId === parsed.observationId || seenObservationIds.has(parsed.observationId)) continue;
      updates.push(parsed.weekly ? parsed : { ...parsed, continuity: "uncertain" });
    }

    const mainLog = await readBoundedMainLog(
      this.#paths.mainLogPath,
      this.#cursor.mainLogSize,
      startup,
      this.#options.mainLogOverlapBytes,
      this.#options.maxMainLogReadBytes,
    );
    if (mainLog.overflow) errors.push("Rotation main log exceeded bounded overlap; Observation Continuity is uncertain");
    const completedRoutes = mainLog.routes.filter((route) => !seenRouteTraceIds.has(route.traceId));
    const proxyAccountsResult = await readAccounts(this.#paths.authDir);
    const proxyAccountErrors = proxyAccountsResult.errors;
    errors.push(...proxyAccountErrors);
    const merged = await mergeObservedQuotaUpdates(this.#paths, proxyAccountsResult.accounts, updates, completedRoutes);
    errors.push(...merged.errors);

    const observedAt = new Date().toISOString();
    const mergeSucceeded = proxyAccountErrors.length === 0 && merged.errors.length === 0;
    const deliveredUpdates = mergeSucceeded ? updates : [];
    const deliveredRoutes = mergeSucceeded ? completedRoutes : [];
    const nextErrorFingerprint = errorFingerprint(errors);
    const errorChanged = nextErrorFingerprint !== this.#cursor.lastErrorFingerprint;
    const batch = deliveredUpdates.length > 0 || deliveredRoutes.length > 0 || (errors.length > 0 && errorChanged)
      ? {
          updates: deliveredUpdates,
          completedRoutes: deliveredRoutes,
          snapshotsByCanonicalIdentity: merged.snapshotsByCanonicalIdentity,
          errors,
          observedAt,
        }
      : null;
    let wakeSucceeded = true;
    if (batch) {
      try {
        await this.#options.onObservation?.(batch);
      } catch (error) {
        wakeSucceeded = false;
        errors.push(`Rotation controller wake failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const safeResponseProgress = mergeSucceeded && responseScanSucceeded && selected.length > 0;
    const safeMainLogProgress = mergeSucceeded && !mainLog.overflow && mainLog.size !== this.#cursor.mainLogSize;
    if (wakeSucceeded && (batch || safeResponseProgress || safeMainLogProgress)) {
      if (mergeSucceeded && responseScanSucceeded) nextCursor.responseFiles = Object.fromEntries(tracked.flatMap((file) => {
        const previous = this.#cursor.responseFiles[file.name];
        const changed = !previous || previous.size !== file.size || previous.mtimeMs !== file.mtimeMs;
        if (changed && !selectedNames.has(file.name)) return previous ? [[file.name, previous] as const] : [];
        const observationId = observationIdByFile.get(file.name) ?? this.#cursor.responseFiles[file.name]?.observationId;
        return [[file.name, {
          size: file.size,
          mtimeMs: file.mtimeMs,
          ...(observationId ? { observationId } : {}),
        }] as const];
      }));
      if (mergeSucceeded && !mainLog.overflow) nextCursor.mainLogSize = mainLog.size;
      if (mergeSucceeded) {
        nextCursor.seenObservationIds = boundedAppend(nextCursor.seenObservationIds, deliveredUpdates.flatMap((update) => update.observationId ? [update.observationId] : []), this.#options.maxSeenIds);
        nextCursor.seenRouteTraceIds = boundedAppend(nextCursor.seenRouteTraceIds, deliveredRoutes.map((route) => route.traceId), this.#options.maxSeenIds);
      }
      nextCursor.lastErrorFingerprint = nextErrorFingerprint;
      nextCursor.updatedAt = observedAt;
      await mkdir(path.dirname(this.#statePath), { recursive: true });
      await atomicWriteText(this.#statePath, `${JSON.stringify(nextCursor, null, 2)}\n`);
      this.#cursor = nextCursor;
    }
    return batch;
  }
}

export async function createRotationLogObserver(
  dashboardOptions: DashboardOptions,
  options: RotationLogObserverOptions = {},
): Promise<RotationLogObserver> {
  const paths = await resolveDashboardPaths(dashboardOptions);
  const statePath = path.resolve(options.statePath ?? path.join(path.dirname(paths.quotaSnapshotStatePath), "rotation-observer-cursor.json"));
  const cursor = await readCursor(statePath);
  return new RotationLogObserver(paths, statePath, cursor, options);
}
