import { describe, expect, it } from "vitest";

import {
  classifyQuotaWindow,
  decideRotation,
  deriveCredentialFingerprint,
  hasVerifiedCredentialIdentity,
  isRotationEligible,
} from "../rotation-policy.js";
import type { RotationAccountSnapshot, RotationDecisionInput } from "../rotation-types.js";

function account(overrides: Partial<RotationAccountSnapshot> = {}): RotationAccountSnapshot {
  return {
    proxyAccountKey: "pak_" + (overrides.fileName ?? "a"),
    fileName: overrides.fileName ?? "codex-a.json",
    enabled: true,
    sessionValid: true,
    observable: true,
    observationContinuity: "continuous",
    rotationPoolMember: true,
    exclusivityAttested: true,
    identityFingerprint: "fp-a",
    identityVerified: true,
    weekly: {
      usedPercent: 10,
      observedAt: "2026-07-15T00:00:00.000Z",
      resetAt: "2026-07-22T00:00:00.000Z",
      durationMinutes: 10080,
      windowKind: "weekly",
      evidenceId: "e-a",
      credentialFingerprint: "fp-a",
      continuity: "continuous",
      schemaVersion: 2,
    },
    exhausted: false,
    cooldownUntil: undefined,
    lastSelectedAt: undefined,
    ...overrides,
  };
}

function decisionInput(overrides: Partial<RotationDecisionInput> = {}): RotationDecisionInput {
  const active = account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", weekly: {
    usedPercent: 20,
    observedAt: "2026-07-15T00:00:00.000Z",
    resetAt: "2026-07-22T00:00:00.000Z",
    durationMinutes: 10080,
    windowKind: "weekly",
    evidenceId: "e-active",
    credentialFingerprint: "fp-active",
    continuity: "continuous",
    schemaVersion: 2,
  }, identityFingerprint: "fp-active" });
  const low = account({ fileName: "codex-low.json", proxyAccountKey: "pak-low", identityFingerprint: "fp-low", weekly: { ...account().weekly!, credentialFingerprint: "fp-low" } });
  return {
    accounts: [active, low],
    routingTargetKey: active.proxyAccountKey,
    nowMs: Date.parse("2026-07-15T00:01:00.000Z"),
    recentAutomaticSwitches: [],
    observationId: "obs-1",
    mode: "active",
    ...overrides,
  };
}

describe("rotation policy", () => {
  it("classifies duration, never position", () => {
    expect(classifyQuotaWindow(10080)).toBe("weekly");
    expect(classifyQuotaWindow(300)).toBe("five-hour");
    expect(classifyQuotaWindow(0)).toBe("unknown");
    expect(classifyQuotaWindow("10080")).toBe("unknown");
  });

  it("keeps fingerprint across token refresh and changes it after stable identity replacement", () => {
    const secret = "test-secret";
    const token = (claims: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    const raw = {
      email: "A@example.com",
      account_id: "acct-a",
      refresh_token: "refresh-a",
      id_token: token({ sub: "subject-a", email: "a@example.com" }),
    };
    expect(deriveCredentialFingerprint(secret, "codex-a.json", raw)).toBe(
      deriveCredentialFingerprint(secret, "codex-a.json.disabled", raw),
    );
    expect(deriveCredentialFingerprint(secret, "codex-a.json", raw)).toBe(
      deriveCredentialFingerprint(secret, "codex-a.json", {
        ...raw,
        refresh_token: "refresh-b",
        id_token: token({ sub: "subject-a", email: "a@example.com", iat: 2 }),
      }),
    );
    expect(deriveCredentialFingerprint(secret, "codex-a.json", raw)).not.toBe(
      deriveCredentialFingerprint(secret, "codex-a.json", { ...raw, account_id: "acct-b" }),
    );
    expect(hasVerifiedCredentialIdentity({ id_token: "opaque-token" })).toBe(false);
    expect(hasVerifiedCredentialIdentity({ id_token: token({ sub: "subject-a" }) })).toBe(true);
  });

  it("requires every safety condition for eligibility", () => {
    expect(isRotationEligible(account())).toBe(true);
    expect(isRotationEligible(account({ rotationPoolMember: false }))).toBe(false);
    expect(isRotationEligible(account({ weekly: { ...account().weekly!, windowKind: "unknown" } }))).toBe(false);
    expect(isRotationEligible(account({ weekly: { ...account().weekly!, resetAt: undefined } }))).toBe(false);
    expect(isRotationEligible(account({ weekly: { ...account().weekly!, schemaVersion: 999 } }))).toBe(false);
    expect(isRotationEligible(account({ observationContinuity: "broken" }))).toBe(false);
    expect(isRotationEligible(account({ provisionalReset: true }))).toBe(false);
  });

  it("switches at precise five-point spread and not below", () => {
    expect(decideRotation(decisionInput()).kind).toBe("switch");
    expect(decideRotation(decisionInput({ accounts: [account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 19, credentialFingerprint: "fp-active" } }), account({ weekly: { ...account().weekly!, usedPercent: 15 } })] })).kind).toBe("hold");
  });

  it("uses LRU then stable key tie-breaks and blocks fourth switch", () => {
    const lowA = account({ fileName: "codex-a.json", proxyAccountKey: "pak-a", lastSelectedAt: 100 });
    const lowB = account({ fileName: "codex-b.json", proxyAccountKey: "pak-b", lastSelectedAt: 200 });
    const active = account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 20, credentialFingerprint: "fp-active" } });
    expect(decideRotation(decisionInput({ accounts: [active, lowA, lowB] })).targetKey).toBe("pak-a");
    expect(decideRotation(decisionInput({ recentAutomaticSwitches: [0, 1, 2].map((n) => Date.parse("2026-07-15T00:00:00.000Z") + n) })).kind).toBe("pause");
  });

  it("pauses with no eligible member and marks provisional reset ineligible", () => {
    expect(decideRotation(decisionInput({ accounts: [account({ provisionalReset: true })] })).kind).toBe("pause");
  });
});
