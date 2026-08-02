import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import path from "node:path";

import { DASHBOARD_STATE_DIR_NAME } from "./constants.js";
import { readLogSummary } from "./logs.js";
import { resolveDashboardPaths } from "./paths.js";
import { deriveProxyAccountKey, readQuotaSnapshotStoreFile } from "./quota-store.js";
import type {
  DashboardOptions,
  DashboardPaths,
  PersistedQuotaSnapshotStore,
  RequestLogLine,
  SelectorLogLine,
  ShadowObservationRecord,
} from "./types.js";
import { normalizeProxyAccountLocalIdentity } from "./util.js";

export const SHADOW_OBSERVATION_FEED_PATH = "/api/shadow-observation-feed";

export const APPROVED_SHADOW_OBSERVATION_FIELDS = Object.freeze([
  "clientWorkloadId",
  "requestKind",
  "normalizedModelId",
  "observedAtUnixMs",
  "candidateDecisionId",
  "selectedAccountIds",
  "blockedAccountIds",
  "reasonCategory",
  "latencyBucketMs",
  "errorClass",
]);

type AccountKeyMapper = (auth: string) => string | null;

export async function readShadowObservationFeed(
  options: DashboardOptions = {},
): Promise<ShadowObservationRecord[]> {
  const paths = await resolveDashboardPaths(options);
  const [logSummary, accountKeyForAuth] = await Promise.all([
    readLogSummary(paths.mainLogPath),
    createReadOnlyAccountKeyMapper(paths),
  ]);
  const selectionsByTraceId = new Map(
    logSummary.recentSelections.map((selection) => [selection.traceId, selection]),
  );
  return logSummary.recentRequests.flatMap((request) => {
    const observedAtUnixMs = Date.parse(request.timestamp);
    if (!Number.isFinite(observedAtUnixMs)) return [];
    return [
      sanitizeShadowObservationRecord(
        request,
        selectionsByTraceId.get(request.traceId) ?? null,
        accountKeyForAuth,
        observedAtUnixMs,
      ),
    ];
  });
}

function sanitizeShadowObservationRecord(
  request: RequestLogLine,
  selection: SelectorLogLine | null,
  accountKeyForAuth: AccountKeyMapper,
  observedAtUnixMs: number,
): ShadowObservationRecord {
  const selectedAccountId = selection?.auth ? accountKeyForAuth(selection.auth) : null;
  return {
    clientWorkloadId: normalizeClientWorkloadId(request.client),
    requestKind: requestKind(request.method, request.path),
    normalizedModelId: normalizeModelId(selection?.model ?? ""),
    observedAtUnixMs,
    candidateDecisionId: candidateDecisionId(request.traceId),
    selectedAccountIds: selectedAccountId ? [selectedAccountId] : [],
    blockedAccountIds: [],
    reasonCategory: reasonCategory(request.status),
    latencyBucketMs: latencyBucketMs(request.duration),
    errorClass: errorClass(request.status),
  };
}

async function createReadOnlyAccountKeyMapper(paths: DashboardPaths): Promise<AccountKeyMapper> {
  const store = await readExistingQuotaStore(paths);
  if (!store) return () => null;
  return (auth) => {
    const canonicalLocalIdentity = normalizeProxyAccountLocalIdentity(path.basename(auth));
    if (!canonicalLocalIdentity.startsWith("codex-")) return null;
    try {
      return deriveProxyAccountKey(store, canonicalLocalIdentity);
    } catch {
      return null;
    }
  };
}

async function readExistingQuotaStore(paths: DashboardPaths): Promise<PersistedQuotaSnapshotStore | null> {
  if (!quotaSnapshotPathLooksDashboardOwned(paths)) return null;
  try {
    const metadata = await lstat(paths.quotaSnapshotStatePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const result = await readQuotaSnapshotStoreFile(paths.quotaSnapshotStatePath);
  return result.dirty ? null : result.store;
}

function quotaSnapshotPathLooksDashboardOwned(paths: DashboardPaths): boolean {
  const stateRoot = path.resolve(paths.authDir, DASHBOARD_STATE_DIR_NAME);
  const statePath = path.resolve(paths.quotaSnapshotStatePath);
  const relative = path.relative(stateRoot, statePath);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    path.dirname(statePath) === stateRoot
  );
}

function normalizeClientWorkloadId(client: string): string {
  const normalized = client.trim().toLowerCase();
  if (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.0.0.1:")
  ) {
    return "loopback-local";
  }
  if (!normalized) return "unknown";
  return "non-loopback-or-redacted";
}

function requestKind(method: string, requestPath: string): string {
  const normalizedMethod = method.trim().toUpperCase();
  const pathOnly = requestPath.split("?")[0] ?? "";
  if (normalizedMethod === "POST" && pathOnly === "/v1/responses") return "responses";
  if (normalizedMethod === "POST" && pathOnly === "/v1/chat/completions") return "chat-completions";
  if (normalizedMethod === "POST" && pathOnly === "/v1/completions") return "completions";
  if (normalizedMethod === "GET" && pathOnly === "/v1/models") return "models";
  if (normalizedMethod === "GET" && pathOnly === "/v1/ws") return "websocket";
  return "unknown";
}

function normalizeModelId(model: string): string | null {
  const normalized = model.trim();
  if (!normalized) return null;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(normalized)) return null;
  return normalized;
}

function candidateDecisionId(traceId: string): string {
  const digest = createHash("sha256")
    .update("cliproxy-dashboard shadow observation v1\0")
    .update(traceId, "utf8")
    .digest("base64url");
  return `bridge_${digest}`;
}

function reasonCategory(status: number): string {
  if (status >= 200 && status < 300) return "success";
  if (status === 101) return "protocol-upgrade";
  if (status >= 400 && status < 500) return "client-error";
  if (status >= 500 && status < 600) return "server-error";
  return "unknown";
}

function errorClass(status: number): string | null {
  if (status < 400) return null;
  if (status < 500) return "http-4xx";
  if (status < 600) return "http-5xx";
  return "http-other";
}

function latencyBucketMs(duration: string): number | null {
  const milliseconds = durationToMilliseconds(duration);
  if (milliseconds === null) return null;
  for (const bucket of [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000]) {
    if (milliseconds <= bucket) return bucket;
  }
  return 120_000;
}

function durationToMilliseconds(duration: string): number | null {
  const normalized = duration.trim().toLowerCase();
  const match = /^(?<value>\d+(?:\.\d+)?)(?<unit>ns|us|ms|s|m)$/.exec(normalized);
  if (!match?.groups) return null;
  const value = Number(match.groups.value);
  if (!Number.isFinite(value)) return null;
  switch (match.groups.unit) {
    case "ns":
      return value / 1_000_000;
    case "us":
      return value / 1_000;
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    default:
      return null;
  }
}
