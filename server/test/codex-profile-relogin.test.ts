import { describe, expect, it, vi } from "vitest";

import { CodexProfileOnboardingService } from "../codex-profile-onboarding-service.js";

const profile = {
  id: `profile_${"a".repeat(32)}`,
  status: "confirmed" as const,
  label: "Primary",
  enabled: false,
  order: 0,
  runtimeContext: {
    codexStateRoot: "/private/codex-profiles/primary",
    codexSqliteRoot: "/private/codex-profiles/primary",
  },
};
const oldSnapshot = {
  account: { email: "operator@example.com", plan: "pro" },
  observedAt: "2026-07-19T04:00:00.000Z",
  usage: { primary: null, secondary: null },
  resetCredits: { availableCount: 1 },
  runtimeVersion: "codex-cli 0.144.4",
  freshness: "re-login-required" as const,
};

function setup(
  reloginDisposition: "unbound" | "matching-retained" | "mismatch" = "unbound",
  options: {
    deletionDisposition?: "safe" | "blocked" | "recovery-required" | "unavailable";
    currentState?: object;
    cancelError?: Error;
  } = {},
) {
  const runtimeIdentity = {
    canonicalPath: "/canonical/bin/codex",
    ...profile.runtimeContext,
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4",
    schemaHash: "schema-hash",
  };
  const registry = {
    create: vi.fn(),
    get: vi.fn(async () => profile),
    confirm: vi.fn(),
    cancel: vi.fn(),
    updateMetadata: vi.fn(async (_profileId: string, input: { enabled?: boolean }) => ({ ...profile, ...input })),
  };
  const observationStore = {
    get: vi.fn(async () => ({ generation: 1, snapshot: oldSnapshot })),
    replace: vi.fn(async (_profileId: string, _generation: number | null, snapshot: typeof oldSnapshot) => ({
      generation: 2,
      snapshot,
    })),
    remove: vi.fn(),
    isReLoginRequired: vi.fn(async () => true),
  };
  const loginRunner = {
    start: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    cancel: vi.fn(async () => {
      if (options.cancelError) throw options.cancelError;
    }),
  };
  const qualifier = {
    qualify: vi.fn(async () => ({ status: "qualified" as const, version: runtimeIdentity.version, identity: runtimeIdentity })),
    matchesIdentity: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  const gateway = {
    readAccount: vi.fn(async () => ({
      account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
      providerRequiresOpenAiAuth: false,
    })),
    readRateLimits: vi.fn(async () => ({
      rateLimits: { limitId: "codex", limitName: "Codex", primary: null, secondary: null, plan: "pro" as const },
      rateLimitsByLimitId: null,
      resetCredits: { availableCount: 2, credits: null },
    })),
    close: vi.fn(async () => {}),
  };
  const release = vi.fn(async () => {});
  const acquire = vi.fn(async () => ({ profileId: profile.id, operation: "re-login" as const, release }));
  const redemptionService = {
    currentState: vi.fn(async () => options.currentState ?? ({ status: "not-found" as const })),
    deletionDisposition: vi.fn(async () => options.deletionDisposition ?? "safe" as const),
    reloginDisposition: vi.fn(async () => reloginDisposition),
  };
  const service = new CodexProfileOnboardingService({
    registry,
    observationStore,
    loginRunner,
    codexBin: "/trusted/bin/codex",
    qualifier,
    startReadGateway: vi.fn(async () => gateway),
    lifecycleFence: { acquire },
    lifecycleStore: { getCleanupRequired: vi.fn(async () => null) },
    redemptionService,
    now: () => new Date("2026-07-20T00:00:00.000Z"),
  });
  return { service, registry, observationStore, loginRunner, qualifier, acquire, release, redemptionService };
}

describe("Codex Login Profile re-login", () => {
  it("reuses the immutable root and enables only after a fresh explicitly confirmed account check", async () => {
    const test = setup();

    await expect(test.service.startReLogin(profile.id)).resolves.toEqual({
      profileId: profile.id,
      status: "login-in-progress",
    });
    expect(test.loginRunner.start).toHaveBeenCalledWith({
      profileId: profile.id,
      codexBin: "/canonical/bin/codex",
      runtimeContext: profile.runtimeContext,
    });
    const candidate = await test.service.observe(profile.id);
    await expect(test.service.confirm(profile.id, {
      confirmed: true,
      email: candidate.account.email,
      plan: candidate.account.plan,
    })).resolves.toMatchObject({ status: "confirmed", account: oldSnapshot.account });

    expect(test.observationStore.remove).not.toHaveBeenCalled();
    expect(test.registry.confirm).not.toHaveBeenCalled();
    expect(test.registry.updateMetadata).toHaveBeenCalledWith(profile.id, { enabled: true });
    expect(test.release).toHaveBeenCalledTimes(1);
  });

  it("keeps retained recovery and quarantine when the fresh account cannot match it", async () => {
    const test = setup("mismatch");
    await test.service.startReLogin(profile.id);
    const candidate = await test.service.observe(profile.id);

    await expect(test.service.confirm(profile.id, {
      confirmed: true,
      email: candidate.account.email,
      plan: candidate.account.plan,
    })).rejects.toMatchObject({ code: "retained-redemption-mismatch" });

    expect(test.observationStore.replace).not.toHaveBeenCalled();
    expect(test.registry.updateMetadata).not.toHaveBeenCalledWith(profile.id, { enabled: true });
    expect(test.release).not.toHaveBeenCalled();
  });

  it("holds the lifecycle fence while rejecting retained redemption states that are not ambiguous", async () => {
    const test = setup("unbound", {
      deletionDisposition: "blocked",
      currentState: {
        status: "processing",
        proposalId: "proposal",
        allowedAction: "poll",
        selectionMode: "generic",
        phase: "dispatch-intent",
        dispatchAt: "2026-07-20T00:00:00.000Z",
      },
    });

    await expect(test.service.startReLogin(profile.id)).rejects.toMatchObject({ code: "recovery-unavailable" });

    expect(test.acquire.mock.invocationCallOrder[0]).toBeLessThan(
      test.redemptionService.deletionDisposition.mock.invocationCallOrder[0],
    );
    expect(test.release).toHaveBeenCalledTimes(1);
    expect(test.registry.updateMetadata).not.toHaveBeenCalled();
    expect(test.loginRunner.start).not.toHaveBeenCalled();
  });

  it("fails closed and releases the lifecycle fence when prior login cancellation fails", async () => {
    const test = setup("unbound", { cancelError: new Error("cancel failed") });

    await expect(test.service.startReLogin(profile.id)).rejects.toMatchObject({ code: "cleanup-failed" });

    expect(test.release).toHaveBeenCalledTimes(1);
    expect(test.loginRunner.start).not.toHaveBeenCalled();
  });
});
