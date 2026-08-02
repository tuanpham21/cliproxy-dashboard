import path from "node:path";

import type { PersistedQuotaSnapshot, PersistedQuotaWindowEvidence, PublicQuotaSnapshot, PublicQuotaStatus, PublicQuotaWindow, QuotaWindowName } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function parseOptionalInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

export function asHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export function normalizeProxyAccountLocalIdentity(value: string): string {
  return path.basename(value).replace(/\.disabled$/, "");
}

export function emptyPublicQuotaSnapshot(): PublicQuotaSnapshot {
  return {
    primary5h: { status: "unknown" },
    weekly: { status: "unknown" },
  };
}

export function normalizeUsedPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (value < 0 || value > 100) {
    return undefined;
  }
  return value;
}

export function observedMsFromIso(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function evidenceIsNewer(
  next: PersistedQuotaWindowEvidence,
  current: PersistedQuotaWindowEvidence | undefined,
): boolean {
  if (!current) {
    return true;
  }
  const nextMs = observedMsFromIso(next.observedAt);
  const currentMs = observedMsFromIso(current.observedAt);
  if (nextMs !== currentMs) {
    return nextMs > currentMs;
  }
  return Boolean(next.evidenceId && next.evidenceId !== current.evidenceId && !current.evidenceId);
}

export function publicQuotaWindow(
  evidence: PersistedQuotaWindowEvidence | undefined,
  nowMs = Date.now(),
  snapshot?: PersistedQuotaSnapshot,
): PublicQuotaWindow {
  if (!evidence) {
    return { status: "unknown" };
  }
  const resetMs = evidence.resetAt ? Date.parse(evidence.resetAt) : NaN;
  const continuity = snapshot?.identityMismatch
    ? "broken"
    : snapshot?.observationContinuity ?? evidence.continuity ?? (evidence.windowKind ? "continuous" : "uncertain");
  const identityBound = Boolean(
    evidence.credentialFingerprint &&
    snapshot?.credentialFingerprint &&
    evidence.credentialFingerprint === snapshot.credentialFingerprint &&
    !snapshot.identityMismatch,
  );
  let status: PublicQuotaStatus;
  const resetInFuture = Number.isFinite(resetMs) && resetMs > nowMs;

  if (evidence.migrationOnly || evidence.windowKind === "unknown") {
    status = "unsupported-provider-window";
  } else if (continuity === "broken") {
    status = resetInFuture ? "stale" : "refresh-needed";
  } else if (resetInFuture) {
    status = "current";
  } else {
    status = "refresh-needed";
  }

  return {
    status,
    usedPercent: evidence.usedPercent,
    rawUsedPercent: evidence.rawUsedPercent,
    resetAt: evidence.resetAt,
    observedAt: evidence.observedAt,
    source: evidence.source,
    durationMinutes: evidence.durationMinutes,
    windowKind: evidence.windowKind,
    providerSlot: evidence.providerSlot,
    continuity,
    migrationOnly: evidence.migrationOnly ?? !evidence.windowKind,
    identityBound,
  };
}

export function computeAccountRotationDisplayStatus(
  account: { disabled: boolean; validityStatus?: string; fileName: string },
  snapshot: PersistedQuotaSnapshot | undefined,
  nowMs = Date.now(),
): { eligible: boolean; reason?: string } {
  if (account.disabled) {
    return { eligible: false, reason: "Account disabled" };
  }
  if (account.validityStatus && account.validityStatus !== "valid") {
    return { eligible: false, reason: "Session ended or unverified" };
  }
  if (!snapshot) {
    return { eligible: false, reason: "No quota evidence recorded" };
  }
  if (snapshot.identityMismatch) {
    return { eligible: false, reason: "Identity unverified or changed" };
  }
  if (snapshot.observationContinuity === "broken") {
    return { eligible: false, reason: "Observation continuity broken" };
  }
  const weekly = snapshot.weekly;
  if (!weekly || weekly.migrationOnly || weekly.windowKind !== "weekly" || weekly.durationMinutes !== 10_080) {
    return { eligible: false, reason: "Unsupported or missing weekly provider window" };
  }
  if (!weekly.credentialFingerprint || weekly.credentialFingerprint !== snapshot.credentialFingerprint) {
    return { eligible: false, reason: "Identity unbound" };
  }
  const resetMs = weekly.resetAt ? Date.parse(weekly.resetAt) : NaN;
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return { eligible: false, reason: "Weekly quota refresh needed" };
  }
  if (weekly.usedPercent !== undefined && weekly.usedPercent >= 100) {
    return { eligible: false, reason: "Weekly quota exhausted" };
  }
  return { eligible: true };
}

export function toPublicQuotaSnapshot(
  snapshot: PersistedQuotaSnapshot | undefined,
  nowMs = Date.now(),
): PublicQuotaSnapshot {
  if (!snapshot) {
    return {
      primary5h: { status: "unknown" },
      weekly: { status: "unknown" },
    };
  }
  return {
    primary5h: publicQuotaWindow(snapshot.primary5h, nowMs, snapshot),
    weekly: publicQuotaWindow(snapshot.weekly, nowMs, snapshot),
  };
}
