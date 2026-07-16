import { createHmac } from "node:crypto";

import type {
  RotationAccountSnapshot,
  RotationDecision,
  RotationDecisionInput,
  SemanticQuotaEvidence,
  QuotaWindowKind,
} from "./rotation-types.js";

export function classifyQuotaWindow(durationMinutes: unknown): QuotaWindowKind {
  if (typeof durationMinutes !== "number" || !Number.isFinite(durationMinutes) || durationMinutes <= 0) {
    return "unknown";
  }
  if (durationMinutes === 10_080) {
    return "weekly";
  }
  if (durationMinutes === 300) {
    return "five-hour";
  }
  return "unknown";
}

function canonicalFileName(fileName: string): string {
  return fileName.replace(/\.disabled$/, "");
}

function stringClaim(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordClaim(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function idTokenClaims(raw: Record<string, unknown>): Record<string, unknown> {
  const idToken = stringClaim(raw.id_token);
  const parts = idToken.split(".");
  if (parts.length !== 3) return {};
  try {
    return recordClaim(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown);
  } catch {
    return {};
  }
}

function stableIdentityClaims(raw: Record<string, unknown>): { accountId: string; subject: string; email: string } {
  const token = idTokenClaims(raw);
  const openAiAuth = recordClaim(token["https://api.openai.com/auth"]);
  const profile = recordClaim(token["https://api.openai.com/profile"]);
  return {
    accountId: stringClaim(raw.account_id) || stringClaim(openAiAuth.chatgpt_account_id) || stringClaim(token.account_id),
    subject: stringClaim(token.sub),
    email: (stringClaim(raw.email) || stringClaim(token.email) || stringClaim(profile.email)).toLowerCase(),
  };
}

function identityMaterial(fileName: string, raw: Record<string, unknown>): string {
  const { accountId, subject, email } = stableIdentityClaims(raw);
  const stable = [accountId, subject, email].join("\0");
  return stable.replace(/\0/g, "") ? stable : canonicalFileName(fileName);
}

export function deriveCredentialFingerprint(
  secret: string,
  fileName: string,
  raw: Record<string, unknown>,
): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update("cliproxy-dashboard credential-fingerprint v1\0")
    .update(identityMaterial(fileName, raw), "utf8")
    .digest("base64url");
}

export function hasVerifiedCredentialIdentity(raw: Record<string, unknown>): boolean {
  const { accountId, subject, email } = stableIdentityClaims(raw);
  return Boolean(accountId || subject || email);
}

export function isFreshWeeklyEvidence(evidence: SemanticQuotaEvidence | undefined, nowMs: number): boolean {
  if (!evidence || evidence.windowKind !== "weekly" || evidence.migrationOnly) {
    return false;
  }
  if (evidence.continuity !== "continuous" || !Number.isFinite(evidence.usedPercent)) {
    return false;
  }
  const resetMs = evidence.resetAt ? Date.parse(evidence.resetAt) : NaN;
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return false;
  }
  return evidence.schemaVersion === 2 && evidence.durationMinutes === 10_080 && Boolean(evidence.evidenceId && evidence.credentialFingerprint);
}

export function isRotationEligible(account: RotationAccountSnapshot, nowMs = Date.now()): boolean {
  return Boolean(
    account.rotationPoolMember &&
      account.exclusivityAttested &&
      account.enabled &&
      account.sessionValid &&
      account.observable &&
      account.observationContinuity === "continuous" &&
      !account.exhausted &&
      (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= nowMs) &&
      !account.provisionalReset &&
      account.identityVerified &&
      isFreshWeeklyEvidence(account.weekly, nowMs) &&
      account.weekly?.credentialFingerprint === account.identityFingerprint,
  );
}

function candidateSort(left: RotationAccountSnapshot, right: RotationAccountSnapshot): number {
  const leftSelected = left.lastSelectedAt ?? Number.NEGATIVE_INFINITY;
  const rightSelected = right.lastSelectedAt ?? Number.NEGATIVE_INFINITY;
  if (leftSelected !== rightSelected) {
    return leftSelected - rightSelected;
  }
  return left.proxyAccountKey.localeCompare(right.proxyAccountKey);
}

export function decideRotation(input: RotationDecisionInput): RotationDecision {
  if (input.mode === "off") {
    return { kind: "hold", reason: "rotation is off" };
  }
  if (input.seenObservationIds?.includes(input.observationId)) {
    return { kind: "hold", reason: "observation already consumed" };
  }
  const eligible = input.accounts.filter((account) => isRotationEligible(account, input.nowMs));
  if (eligible.length === 0) {
    return { kind: "pause", reason: "no Rotation-Eligible Proxy Account", pauseReason: "no-eligible-members" };
  }
  const target = input.accounts.find((account) => account.proxyAccountKey === input.routingTargetKey) ?? eligible[0];
  const targetUnavailable = !isRotationEligible(target, input.nowMs);
  const candidates = eligible.filter((account) => account.proxyAccountKey !== target.proxyAccountKey).sort(candidateSort);
  const active = target.weekly?.usedPercent;
  if (active === undefined) {
    return { kind: "pause", reason: "active target has no weekly evidence", pauseReason: "observation-uncertain" };
  }
  const lowest = candidates.length > 0
    ? Math.min(...candidates.map((account) => account.weekly!.usedPercent))
    : active;
  if (targetUnavailable) {
    const fallback = candidates[0] ?? eligible[0];
    if (fallback.proxyAccountKey === target.proxyAccountKey) {
      return { kind: "pause", reason: "target unavailable and no alternate member", pauseReason: "no-eligible-members" };
    }
    return { kind: "switch", reason: "routing target unavailable", targetKey: fallback.proxyAccountKey, activeUsedPercent: active, lowestUsedPercent: lowest, spread: undefined };
  }
  if (input.recentAutomaticSwitches.filter((at) => input.nowMs - at < 60 * 60 * 1000 && at <= input.nowMs).length >= 3) {
    return { kind: "pause", reason: "automatic switch budget exhausted", pauseReason: "switch-budget-exhausted" };
  }
  const spread = active - lowest;
  if (spread < 5) {
    return { kind: "hold", reason: "Quota Spread below five percentage points", activeUsedPercent: active, lowestUsedPercent: lowest, spread };
  }
  const candidate = candidates[0];
  if (!candidate) {
    return { kind: "hold", reason: "only one Rotation-Eligible member", activeUsedPercent: active, lowestUsedPercent: lowest, spread };
  }
  return { kind: "switch", reason: "Quota Spread reached five percentage points", targetKey: candidate.proxyAccountKey, activeUsedPercent: active, lowestUsedPercent: lowest, spread };
}
