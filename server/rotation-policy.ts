import { createHmac } from "node:crypto";

import type {
  RotationAccountSnapshot,
  RotationDecision,
  RotationDecisionInput,
  SemanticQuotaEvidence,
  QuotaWindowKind,
} from "./rotation-types.js";

export const DEFAULT_MINIMUM_QUOTA_SPREAD = 5;

export function resolveMinimumQuotaSpread(value: unknown = DEFAULT_MINIMUM_QUOTA_SPREAD): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error("Minimum quota spread must be greater than 0 and no greater than 100 percentage points");
  }
  return value;
}

function minimumQuotaSpreadLabel(value: number): string {
  if (value === 1) return "one percentage point";
  if (value === DEFAULT_MINIMUM_QUOTA_SPREAD) return "five percentage points";
  return `${value} percentage points`;
}

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

function hasRotationWeeklyContract(evidence: SemanticQuotaEvidence | undefined): evidence is SemanticQuotaEvidence {
  return Boolean(
    evidence
      && evidence.windowKind === "weekly"
      && !evidence.migrationOnly
      && evidence.continuity === "continuous"
      && Number.isFinite(evidence.usedPercent)
      && evidence.schemaVersion === 2
      && evidence.durationMinutes === 10_080
      && evidence.evidenceId
      && evidence.credentialFingerprint,
  );
}

export function isFreshWeeklyEvidence(evidence: SemanticQuotaEvidence | undefined, nowMs: number): boolean {
  if (!hasRotationWeeklyContract(evidence)) return false;
  const resetMs = evidence.resetAt ? Date.parse(evidence.resetAt) : NaN;
  if (!Number.isFinite(resetMs) || resetMs <= nowMs) {
    return false;
  }
  return true;
}

function hasRotationAccountPrerequisites(account: RotationAccountSnapshot): boolean {
  return Boolean(
    account.rotationPoolMember
      && account.exclusivityAttested
      && account.enabled
      && account.sessionValid
      && account.observable
      && account.observationContinuity === "continuous"
      && account.identityVerified
      && hasRotationWeeklyContract(account.weekly)
      && account.weekly.credentialFingerprint === account.identityFingerprint,
  );
}

export function isRotationEligible(account: RotationAccountSnapshot, nowMs = Date.now()): boolean {
  return Boolean(
    hasRotationAccountPrerequisites(account) &&
      !account.exhausted &&
      (!account.cooldownUntil || Date.parse(account.cooldownUntil) <= nowMs) &&
      !account.provisionalReset &&
      isFreshWeeklyEvidence(account.weekly, nowMs),
  );
}

export function isProvisionalResetCandidate(account: RotationAccountSnapshot, nowMs = Date.now()): boolean {
  const resetMs = Date.parse(account.weekly?.resetAt ?? "");
  const observedMs = Date.parse(account.weekly?.observedAt ?? "");
  return Boolean(
    hasRotationAccountPrerequisites(account)
      && Number.isFinite(resetMs)
      && Number.isFinite(observedMs)
      && observedMs < resetMs
      && resetMs <= nowMs,
  );
}

function candidateSort(left: RotationAccountSnapshot, right: RotationAccountSnapshot): number {
  const usageDifference = evidenceUsedPercent(left.weekly!) - evidenceUsedPercent(right.weekly!);
  if (usageDifference !== 0) {
    return usageDifference;
  }
  const leftSelected = left.lastSelectedAt ?? Number.NEGATIVE_INFINITY;
  const rightSelected = right.lastSelectedAt ?? Number.NEGATIVE_INFINITY;
  if (leftSelected !== rightSelected) {
    return leftSelected - rightSelected;
  }
  return left.proxyAccountKey.localeCompare(right.proxyAccountKey);
}

function evidenceUsedPercent(evidence: SemanticQuotaEvidence): number {
  return typeof evidence.rawUsedPercent === "number" && Number.isFinite(evidence.rawUsedPercent)
    ? evidence.rawUsedPercent
    : evidence.usedPercent;
}

function switchBudgetExhausted(input: RotationDecisionInput): boolean {
  return input.recentAutomaticSwitches.filter((at) => input.nowMs - at < 60 * 60 * 1000 && at <= input.nowMs).length >= 3;
}

export function decideRotation(input: RotationDecisionInput): RotationDecision {
  const minimumQuotaSpread = resolveMinimumQuotaSpread(input.minimumQuotaSpread);
  const minimumQuotaSpreadDescription = minimumQuotaSpreadLabel(minimumQuotaSpread);
  if (input.mode === "off") {
    return { kind: "hold", reason: "rotation is off" };
  }
  if (input.seenObservationIds?.includes(input.observationId)) {
    return { kind: "hold", reason: "observation already consumed" };
  }
  const observationMs = Date.parse(input.observationAt);
  if (!Number.isFinite(observationMs)) {
    return { kind: "pause", reason: "observation timestamp is invalid", pauseReason: "observation-uncertain" };
  }
  if (input.evidenceWatermark) {
    const watermarkMs = Date.parse(input.evidenceWatermark);
    if (!Number.isFinite(watermarkMs)) {
      return { kind: "pause", reason: "evidence watermark is invalid", pauseReason: "corrupt-state" };
    }
    if (observationMs < watermarkMs) {
      return { kind: "hold", reason: "observation is not newer than evidence watermark" };
    }
  }
  const eligible = input.accounts.filter((account) => isRotationEligible(account, input.nowMs)).sort(candidateSort);
  const configuredTarget = input.accounts.find((account) => account.proxyAccountKey === input.routingTargetKey);
  if (configuredTarget?.provisionalReset) {
    return {
      kind: "hold",
      reason: "Provisional Reset Candidate may receive one normal confirmation request",
      activeUsedPercent: configuredTarget.weekly ? evidenceUsedPercent(configuredTarget.weekly) : undefined,
      lowestUsedPercent: eligible[0]?.weekly ? evidenceUsedPercent(eligible[0].weekly) : undefined,
    };
  }
  if (eligible.length === 0) {
    return { kind: "pause", reason: "no Rotation-Eligible Proxy Account", pauseReason: "no-eligible-members" };
  }
  if (!configuredTarget) {
    if (switchBudgetExhausted(input)) {
      return { kind: "pause", reason: "automatic switch budget exhausted", pauseReason: "switch-budget-exhausted" };
    }
    const fallback = eligible[0];
    return { kind: "switch", reason: "routing target missing", targetKey: fallback.proxyAccountKey, lowestUsedPercent: evidenceUsedPercent(fallback.weekly!), spread: undefined };
  }
  const target = configuredTarget ?? eligible[0];
  const targetUnavailable = !isRotationEligible(target, input.nowMs);
  const candidates = eligible.filter((account) => account.proxyAccountKey !== target.proxyAccountKey).sort(candidateSort);
  const active = target.weekly ? evidenceUsedPercent(target.weekly) : undefined;
  if (targetUnavailable) {
    if (switchBudgetExhausted(input)) {
      return { kind: "pause", reason: "automatic switch budget exhausted", pauseReason: "switch-budget-exhausted" };
    }
    const fallback = eligible[0];
    return { kind: "switch", reason: "routing target unavailable", targetKey: fallback.proxyAccountKey, activeUsedPercent: active, lowestUsedPercent: evidenceUsedPercent(fallback.weekly!), spread: undefined };
  }
  if (active === undefined) {
    return { kind: "pause", reason: "active target has no weekly evidence", pauseReason: "observation-uncertain" };
  }
  const candidate = candidates[0];
  if (!candidate) {
    return { kind: "hold", reason: "only one Rotation-Eligible member", activeUsedPercent: active, lowestUsedPercent: active, spread: 0 };
  }
  const lowest = evidenceUsedPercent(eligible[0].weekly!);
  const spread = active - lowest;
  if (spread < minimumQuotaSpread) {
    return { kind: "hold", reason: `Quota Spread below ${minimumQuotaSpreadDescription}`, activeUsedPercent: active, lowestUsedPercent: lowest, spread };
  }
  if (switchBudgetExhausted(input)) {
    return { kind: "pause", reason: "automatic switch budget exhausted", pauseReason: "switch-budget-exhausted" };
  }
  return { kind: "switch", reason: `Quota Spread reached ${minimumQuotaSpreadDescription}`, targetKey: candidate.proxyAccountKey, activeUsedPercent: active, lowestUsedPercent: lowest, spread };
}
