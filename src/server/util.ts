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
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 100) {
    return undefined;
  }
  return rounded;
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
  return observedMsFromIso(next.observedAt) > observedMsFromIso(current.observedAt);
}

export function publicQuotaWindow(
  evidence: PersistedQuotaWindowEvidence | undefined,
  nowMs = Date.now(),
): PublicQuotaWindow {
  if (!evidence) {
    return { status: "unknown" };
  }
  const resetMs = evidence.resetAt ? Date.parse(evidence.resetAt) : NaN;
  const status: PublicQuotaStatus =
    Number.isFinite(resetMs) && resetMs > nowMs ? "current" : "refresh-needed";
  return {
    status,
    usedPercent: evidence.usedPercent,
    resetAt: evidence.resetAt,
    observedAt: evidence.observedAt,
    source: evidence.source,
  };
}

export function toPublicQuotaSnapshot(
  snapshot: PersistedQuotaSnapshot | undefined,
  nowMs = Date.now(),
): PublicQuotaSnapshot {
  if (!snapshot) {
    return emptyPublicQuotaSnapshot();
  }
  return {
    primary5h: publicQuotaWindow(snapshot.primary5h, nowMs),
    weekly: publicQuotaWindow(snapshot.weekly, nowMs),
  };
}
