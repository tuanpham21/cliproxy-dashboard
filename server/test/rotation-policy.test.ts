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
    observationAt: "2026-07-15T00:01:00.000Z",
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
      expect(isRotationEligible(account({ exclusivityAttested: false }))).toBe(false);
    expect(isRotationEligible(account({ enabled: false }))).toBe(false);
    expect(isRotationEligible(account({ identityVerified: false }))).toBe(false);
    expect(isRotationEligible(account({ sessionValid: false }))).toBe(false);
    expect(isRotationEligible(account({ observable: false }))).toBe(false);
    expect(isRotationEligible(account({ exhausted: true }))).toBe(false);
    expect(isRotationEligible(account({ cooldownUntil: "2026-07-15T00:02:00.000Z" }), Date.parse("2026-07-15T00:01:00.000Z"))).toBe(false);
    expect(isRotationEligible(account({ weekly: { ...account().weekly!, windowKind: "unknown" } }))).toBe(false);
    expect(isRotationEligible(account({ weekly: { ...account().weekly!, resetAt: undefined } }))).toBe(false);
      expect(isRotationEligible(account({ weekly: { ...account().weekly!, schemaVersion: 999 } }))).toBe(false);
      expect(isRotationEligible(account({ weekly: { ...account().weekly!, credentialFingerprint: "different" } }))).toBe(false);
    expect(isRotationEligible(account({ observationContinuity: "broken" }))).toBe(false);
    expect(isRotationEligible(account({ provisionalReset: true }))).toBe(false);
  });

  it("switches at precise five-point spread and not below", () => {
    expect(decideRotation(decisionInput()).kind).toBe("switch");
    expect(decideRotation(decisionInput({ accounts: [account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 19, credentialFingerprint: "fp-active" } }), account({ weekly: { ...account().weekly!, usedPercent: 15 } })] })).kind).toBe("hold");
      expect(decideRotation(decisionInput({ accounts: [account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 19.999, credentialFingerprint: "fp-active" } }), account({ weekly: { ...account().weekly!, usedPercent: 15 } })] })).kind).toBe("hold");
      expect(decideRotation(decisionInput({ accounts: [account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 20, rawUsedPercent: 19.999, credentialFingerprint: "fp-active" } }), account({ weekly: { ...account().weekly!, usedPercent: 15 } })] })).kind).toBe("hold");
      expect(decideRotation(decisionInput({
        accounts: [account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 19.999, credentialFingerprint: "fp-active" } }), account({ weekly: { ...account().weekly!, usedPercent: 15 } })],
        recentAutomaticSwitches: [0, 1, 2].map((n) => Date.parse("2026-07-15T00:00:00.000Z") + n),
      })).kind).toBe("hold");
  });

  it("chooses lowest usage, then LRU and stable key tie-breaks", () => {
    const lowA = account({ fileName: "codex-a.json", proxyAccountKey: "pak-a", lastSelectedAt: 200, weekly: { ...account().weekly!, usedPercent: 10 } });
    const higherButOlder = account({ fileName: "codex-older.json", proxyAccountKey: "pak-older", lastSelectedAt: 100, weekly: { ...account().weekly!, usedPercent: 12 } });
    const lowB = account({ fileName: "codex-b.json", proxyAccountKey: "pak-b", lastSelectedAt: 300, weekly: { ...account().weekly!, usedPercent: 10 } });
    const active = account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 20, credentialFingerprint: "fp-active" } });
    expect(decideRotation(decisionInput({ accounts: [active, higherButOlder, lowA, lowB] })).targetKey).toBe("pak-a");
    const stableA = { ...lowA, lastSelectedAt: 200 };
    const stableB = { ...lowB, lastSelectedAt: 200 };
      expect(decideRotation(decisionInput({ accounts: [active, stableB, stableA] })).targetKey).toBe("pak-a");
      const alreadyLowest = account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 5, credentialFingerprint: "fp-active" } });
      expect(decideRotation(decisionInput({ accounts: [alreadyLowest, lowA] }))).toMatchObject({ kind: "hold", spread: 0, lowestUsedPercent: 5 });
  });

  it("hands off unavailable targets but applies switch budget to every automatic switch", () => {
    const unavailable = account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", exhausted: true, weekly: undefined });
      const fallback = account({ fileName: "codex-fallback.json", proxyAccountKey: "pak-fallback" });
      expect(decideRotation(decisionInput({ accounts: [unavailable, fallback] }))).toMatchObject({ kind: "switch", targetKey: "pak-fallback" });
      expect(decideRotation(decisionInput({ accounts: [fallback], routingTargetKey: "pak-missing" }))).toMatchObject({ kind: "switch", targetKey: "pak-fallback" });
    expect(decideRotation(decisionInput({
      accounts: [unavailable, fallback],
      recentAutomaticSwitches: [0, 1, 2].map((n) => Date.parse("2026-07-15T00:00:00.000Z") + n),
    }))).toMatchObject({ kind: "pause", pauseReason: "switch-budget-exhausted" });
  });

  it("holds duplicate or old observations and ignores provisional reset candidates", () => {
    expect(decideRotation(decisionInput({ seenObservationIds: ["obs-1"] })).kind).toBe("hold");
    expect(decideRotation(decisionInput({ evidenceWatermark: "2026-07-15T00:02:00.000Z" }))).toMatchObject({ kind: "hold", reason: "observation is not newer than evidence watermark" });
    const active = account({ fileName: "codex-active.json", proxyAccountKey: "pak-active", identityFingerprint: "fp-active", weekly: { ...account().weekly!, usedPercent: 20, credentialFingerprint: "fp-active" } });
    const provisional = account({ fileName: "codex-provisional.json", proxyAccountKey: "pak-provisional", provisionalReset: true, weekly: { ...account().weekly!, usedPercent: 0 } });
    const safe = account({ fileName: "codex-safe.json", proxyAccountKey: "pak-safe", weekly: { ...account().weekly!, usedPercent: 14 } });
    expect(decideRotation(decisionInput({ accounts: [active, provisional, safe] }))).toMatchObject({ kind: "switch", targetKey: "pak-safe" });
  });

  it("pauses with no eligible member and holds one eligible member", () => {
    expect(decideRotation(decisionInput({ accounts: [account({ provisionalReset: true })] })).kind).toBe("pause");
    const only = account({ fileName: "codex-only.json", proxyAccountKey: "pak-only" });
    expect(decideRotation(decisionInput({ accounts: [only], routingTargetKey: only.proxyAccountKey }))).toMatchObject({ kind: "hold", reason: "only one Rotation-Eligible member" });
  });
});
