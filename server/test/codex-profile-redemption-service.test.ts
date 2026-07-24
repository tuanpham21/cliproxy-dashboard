import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexProfileRedemptionService } from "../codex-profile-redemption-service.js";
import {
  PrivateRedemptionStateStore,
  type PrivateRedemptionStateStoreDependencies,
} from "../codex-redemption-private-state.js";
import { makeTempRoot } from "./helpers.js";
import { privateStatePlatformDependencies } from "./private-state-platform.js";
import { PROFILE_A, PROFILE_B, profile, rateLimits, runtimeIdentity } from "./codex-profile-redemption-fixture.js";

async function harness(options: { failRecoveryFor?: string; failLegacyRecovery?: boolean } = {}) {
  const parent = await makeTempRoot();
  const rootPathForTests = path.join(parent, "codex-reset-redemption");
  const profileA = profile(PROFILE_A, {
    codexStateRoot: path.join(parent, "profiles", "a"),
    codexSqliteRoot: path.join(parent, "profiles", "a"),
  });
  const profileB = profile(PROFILE_B, {
    codexStateRoot: path.join(parent, "profiles", "b"),
    codexSqliteRoot: path.join(parent, "profiles", "b"),
  });
    const profiles = new Map([[profileA.id, profileA], [profileB.id, profileB]]);
    const cleanupRequired = new Set<string>();
  const registry = {
    get: vi.fn(async (profileId: string) => {
      const result = profiles.get(profileId);
      if (!result) throw new Error("missing profile");
      return result;
    }),
    list: vi.fn(async () => [...profiles.values()]),
  };
  const storeDependencies: PrivateRedemptionStateStoreDependencies = {
    ...privateStatePlatformDependencies(),
    rootPathForTests,
    rootAnchorForTests: parent,
    currentOwner: async () => ({ pid: 1234, processStartIdentity: "boot-a:start-42" }),
    inspectOwner: async (owner) => owner.pid === 1000 ? "dead" : "alive",
    now: () => Date.parse("2026-07-19T12:00:00.000Z"),
  };
  const stores = new Map<string, PrivateRedemptionStateStore>();
  const createProfileStore = vi.fn((profileId: string) => {
    const store = new PrivateRedemptionStateStore({ ...storeDependencies, profileId });
    if (profileId === options.failRecoveryFor) {
      store.initializeRecovery = vi.fn(async () => {
        throw new Error("profile recovery unavailable");
      });
    }
    stores.set(profileId, store);
    return store;
  });
  const qualifier = {
    qualify: vi.fn(async (_codexBin: string, runtimeContext?: CodexRuntimeContext) => ({
      status: "qualified" as const,
      version: "codex-cli 0.144.4",
      identity: runtimeIdentity(runtimeContext!),
    })),
    matchesIdentity: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  const session = { close: vi.fn(async () => {}) };
  const startSession = vi.fn(async () => session);
    const gateway = {
    readAccount: vi.fn(async () => ({
      account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
      providerRequiresOpenAiAuth: true,
    })),
    readRateLimits: vi.fn(async () => rateLimits),
    consumeResetCredit: vi.fn(async (input: {
      idempotencyKey: string;
      creditId?: string;
      beforeWrite?: () => Promise<void> | void;
      afterWrite?: () => Promise<void> | void;
    }) => {
      await input.beforeWrite?.();
      await input.afterWrite?.();
      return { outcome: "alreadyRedeemed" as const };
    }),
    };
    const readProfileObservation = vi.fn(async () => ({
      account: { email: "operator@example.com", plan: "pro" },
      observedAt: "2026-07-19T11:45:00.000Z",
      usage: { primary: null, secondary: null },
      resetCredits: { availableCount: 1 },
      runtimeVersion: "codex-cli 0.144.4",
      freshness: "fresh" as const,
    }));
    const reconcileProfileObservation = vi.fn(async () => {});
  let proposalSequence = 0;
  const legacyStore = new PrivateRedemptionStateStore(storeDependencies);
  if (options.failLegacyRecovery) {
    legacyStore.initializeRecovery = vi.fn(async () => {
      throw new Error("legacy recovery unavailable");
    });
  }
  const service = new CodexProfileRedemptionService({
    qualifier,
      registry,
      createProfileStore,
      legacyStore,
      lifecycleStore: { getCleanupRequired: vi.fn(async (profileId) => cleanupRequired.has(profileId) ? {} as never : null) },
      readProfileObservation,
      reconcileProfileObservation,
    startSession,
    gatewayForSession: () => gateway,
    newProposalId: () => String.fromCharCode("p".charCodeAt(0) + proposalSequence++).repeat(43),
    newIdempotencyKey: () => "11111111-2222-4333-8444-555555555555",
    now: () => new Date("2026-07-19T12:00:00.000Z"),
    schedule: vi.fn(() => ({}) as NodeJS.Timeout),
    clearScheduled: vi.fn(),
    auditSink: vi.fn(async () => {}),
  });
  return {
    service,
    registry,
    profiles,
    qualifier,
    startSession,
    gateway,
    stores,
    storeDependencies,
    legacyStore,
    rootPathForTests,
      profileA,
      cleanupRequired,
      reconcileProfileObservation,
    };
}

describe("profile-scoped Codex reset redemption", () => {
  it("resolves one opaque profile server-side and prepares only under its retained runtime context", async () => {
    const test = await harness();

        const proposal = await test.service.prepare("codex", {
          profileId: PROFILE_A,
          singleWorkspaceAttested: true,
          creditId: "client-selected-credit",
        } as never);

      expect(proposal).toMatchObject({
        status: "prepared",
        proposalId: "p".repeat(43),
        profile: { profileId: PROFILE_A, label: "Primary" },
        selection: { mode: "specific", title: "Early reset" },
      });
    expect(test.registry.get).toHaveBeenCalledWith(PROFILE_A);
    expect(test.qualifier.qualify).toHaveBeenCalledWith("codex", test.profileA.runtimeContext);
    expect(test.startSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeContext: test.profileA.runtimeContext,
    }));
    expect([...test.stores.keys()]).toEqual([PROFILE_A]);
    const journal = JSON.parse(await readFile(
      path.join(test.rootPathForTests, "profiles", PROFILE_A, "active-redemption.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(journal).toMatchObject({
      schemaVersion: 2,
      profileBinding: { profileId: PROFILE_A },
      idempotencyKey: "11111111-2222-4333-8444-555555555555",
    });
    expect(JSON.stringify(journal)).not.toContain(test.profileA.runtimeContext.codexStateRoot);

    await test.service.close();
  });

    it("rejects new proposals for a disabled profile without touching its retained recovery state", async () => {
    const test = await harness();
    test.profiles.set(PROFILE_A, { ...test.profileA, enabled: false });

    await expect(test.service.prepare("codex", {
      profileId: PROFILE_A,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).rejects.toMatchObject({ code: "codex_runtime_incompatible" });

    expect(test.startSession).not.toHaveBeenCalled();
      await expect(test.service.currentState(PROFILE_A)).resolves.toEqual({ status: "not-found" });
    });

    it("cancels fresh preparation when selected profile identity changed", async () => {
      const test = await harness();
      test.gateway.readAccount.mockResolvedValue({
        account: { type: "chatgpt", email: "other@example.com", plan: "pro" },
        providerRequiresOpenAiAuth: true,
      });

      await expect(test.service.prepare("codex", {
        profileId: PROFILE_A,
        singleWorkspaceAttested: true,
      })).rejects.toMatchObject({ code: "codex_account_changed" });
      expect(test.gateway.consumeResetCredit).not.toHaveBeenCalled();
      await expect(test.service.currentState(PROFILE_A)).resolves.toEqual({ status: "not-found" });
    });

  it("reports deletion safety from the exact profile journal rather than terminal tombstone visibility", async () => {
    const test = await harness();
    await expect(test.service.deletionDisposition(PROFILE_A)).resolves.toBe("safe");
    const proposal = await test.service.prepare("codex", {
      profileId: PROFILE_A,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    await expect(test.service.deletionDisposition(PROFILE_A)).resolves.toBe("blocked");

    await test.service.cancel(proposal.proposalId);

    await expect(test.service.deletionDisposition(PROFILE_A)).resolves.toBe("safe");
  });

    it.each(["root", "disabled", "cleanup"] as const)("fails closed before provider mutation when profile %s changes", async (change) => {
      const test = await harness();
    const proposal = await test.service.prepare("codex", {
      profileId: PROFILE_A,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
      if (change === "root") test.profiles.set(PROFILE_A, { ...test.profileA, runtimeContext: {
        codexStateRoot: `${test.profileA.runtimeContext.codexStateRoot}-replacement`,
        codexSqliteRoot: `${test.profileA.runtimeContext.codexSqliteRoot}-replacement`,
      } });
      else if (change === "disabled") test.profiles.set(PROFILE_A, { ...test.profileA, enabled: false });
      else test.cleanupRequired.add(PROFILE_A);

    await expect(test.service.consume(proposal.proposalId, "codex")).rejects.toMatchObject({
      code: "codex_session_changed",
    });
    expect(test.gateway.consumeResetCredit).not.toHaveBeenCalled();

    await test.service.close();
  });

  it("consumes and reconciles through the same profile session with the retained attempt", async () => {
    const test = await harness();
      const proposal = await test.service.prepare("codex", {
        profileId: PROFILE_A,
        singleWorkspaceAttested: true,
      });

      const result = await test.service.consume(proposal.proposalId, "codex");
      expect(result).toMatchObject({
        status: "terminal",
        outcome: "alreadyRedeemed",
        reconciliation: "reconciled",
      });
      expect(JSON.stringify(result)).not.toContain("credit-1");
    expect(test.startSession).toHaveBeenCalledTimes(1);
      expect(test.gateway.consumeResetCredit).toHaveBeenCalledWith(expect.objectContaining({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
        creditId: "credit-1",
      }));
      expect(test.gateway.readRateLimits).toHaveBeenCalledTimes(3);
      expect(test.reconcileProfileObservation).toHaveBeenCalledWith(
        PROFILE_A,
        expect.objectContaining({ resetCredits: expect.objectContaining({ availableCount: 1 }) }),
      );
  });

    it("cancels only the retained profile attempt while another profile stays prepared", async () => {
    const test = await harness();
    const proposalA = await test.service.prepare("codex", {
      profileId: PROFILE_A,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    const proposalB = await test.service.prepare("codex", {
      profileId: PROFILE_B,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });

    await expect(test.service.cancel(proposalA.proposalId)).resolves.toEqual({
      status: "cancelled",
      proposalId: proposalA.proposalId,
    });
    await expect(test.service.state(proposalA.proposalId)).resolves.toEqual({ status: "not-found" });
    await expect(test.service.state(proposalB.proposalId)).resolves.toMatchObject({
      status: "prepared",
      proposalId: proposalB.proposalId,
    });
    await expect(test.stores.get(PROFILE_B)!.readPublicState()).resolves.toMatchObject({
      status: "prepared",
      proposalId: proposalB.proposalId,
    });

      await test.service.close();
    });

    it("cannot consume or reconcile another profile through the selected proposal", async () => {
      const test = await harness();
      const proposalA = await test.service.prepare("codex", {
        profileId: PROFILE_A, creditId: "credit-1", singleWorkspaceAttested: true,
      });
      const proposalB = await test.service.prepare("codex", {
        profileId: PROFILE_B, creditId: "credit-1", singleWorkspaceAttested: true,
      });

      await expect(test.service.consume(proposalA.proposalId, "codex")).resolves.toMatchObject({ status: "terminal" });
      await expect(test.service.currentState(PROFILE_B)).resolves.toMatchObject({
        status: "prepared", proposalId: proposalB.proposalId, profile: { profileId: PROFILE_B },
      });
      expect(test.reconcileProfileObservation).toHaveBeenCalledTimes(1);
      expect(test.reconcileProfileObservation).toHaveBeenCalledWith(PROFILE_A, expect.any(Object));
    });

  it("blocks new redemption only for the profile whose recovery requires repair", async () => {
    const test = await harness({ failRecoveryFor: PROFILE_A });

    await expect(test.service.initializeRecovery("codex")).resolves.toBeUndefined();
    await expect(test.service.currentState(PROFILE_A)).resolves.toMatchObject({
      status: "recovery-required",
      code: "redemption-recovery-required",
    });
    await expect(test.service.prepare("codex", {
      profileId: PROFILE_A,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).rejects.toMatchObject({ code: "redemption-recovery-required" });
    await expect(test.service.prepare("codex", {
      profileId: PROFILE_B,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).resolves.toMatchObject({ status: "prepared" });

    await test.service.close();
  });

  it("reopens only the retained profile context for an ambiguous retry", async () => {
    const test = await harness();
    const originalStore = new PrivateRedemptionStateStore({
      ...test.storeDependencies,
      profileId: PROFILE_A,
      currentOwner: async () => ({ pid: 1000, processStartIdentity: "boot-a:start-1000" }),
    });
    const prepared = await originalStore.acquirePrepared({
      proposalId: "r".repeat(43),
      idempotencyKey: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      accountCheck: { email: "operator@example.com", plan: "pro" },
      selection: { mode: "specific", creditId: "credit-1" },
      runtimeIdentity: runtimeIdentity(test.profileA.runtimeContext),
      createdAt: "2026-07-19T11:55:00.000Z",
      expiresAt: "2026-07-19T11:57:00.000Z",
    });
    const dispatchIntent = await originalStore.transitionJournal(
      prepared.proposalId,
      prepared.ownerNonce,
      "prepared",
      {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-19T11:56:00.000Z",
        updatedAt: "2026-07-19T11:56:00.000Z",
      },
    );
    await originalStore.transitionJournal(
      dispatchIntent.proposalId,
      dispatchIntent.ownerNonce,
      "dispatch-intent",
      {
        ...dispatchIntent,
        phase: "ambiguous",
        updatedAt: "2026-07-19T11:56:01.000Z",
      },
    );

    await test.service.initializeRecovery("codex");
    await expect(test.service.consume(prepared.proposalId, "codex")).resolves.toMatchObject({
      status: "terminal",
      outcome: "alreadyRedeemed",
      reconciliation: "reconciled",
    });
    expect(test.qualifier.qualify).toHaveBeenCalledWith("codex", test.profileA.runtimeContext);
    expect(test.startSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeContext: test.profileA.runtimeContext,
    }));
    expect(test.gateway.consumeResetCredit).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      creditId: "credit-1",
    }));

    await test.service.close();
  });

  it("keeps an ambiguous attempt retained when its profile root changes before retry", async () => {
    const test = await harness();
    const originalStore = new PrivateRedemptionStateStore({
      ...test.storeDependencies,
      profileId: PROFILE_A,
      currentOwner: async () => ({ pid: 1000, processStartIdentity: "boot-a:start-1000" }),
    });
    const prepared = await originalStore.acquirePrepared({
      proposalId: "s".repeat(43),
      idempotencyKey: "aaaaaaaa-bbbb-4ccc-8ddd-111111111111",
      accountCheck: { email: "operator@example.com", plan: "pro" },
      selection: { mode: "generic" },
      runtimeIdentity: runtimeIdentity(test.profileA.runtimeContext),
      createdAt: "2026-07-19T11:55:00.000Z",
      expiresAt: "2026-07-19T11:57:00.000Z",
    });
    const dispatchIntent = await originalStore.transitionJournal(
      prepared.proposalId,
      prepared.ownerNonce,
      "prepared",
      {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-19T11:56:00.000Z",
        updatedAt: "2026-07-19T11:56:00.000Z",
      },
    );
    await originalStore.transitionJournal(
      dispatchIntent.proposalId,
      dispatchIntent.ownerNonce,
      "dispatch-intent",
      {
        ...dispatchIntent,
        phase: "ambiguous",
        updatedAt: "2026-07-19T11:56:01.000Z",
      },
    );
    await test.service.initializeRecovery("codex");
    test.profiles.set(PROFILE_A, {
      ...test.profileA,
      runtimeContext: {
        codexStateRoot: `${test.profileA.runtimeContext.codexStateRoot}-replacement`,
        codexSqliteRoot: `${test.profileA.runtimeContext.codexSqliteRoot}-replacement`,
      },
    });

    await expect(test.service.consume(prepared.proposalId, "codex")).rejects.toMatchObject({
      code: "codex_recovery_session_changed",
    });
    expect(test.gateway.consumeResetCredit).not.toHaveBeenCalled();
    await expect(test.stores.get(PROFILE_A)!.readPublicState(prepared.proposalId)).resolves.toMatchObject({
      status: "ambiguous",
      proposalId: prepared.proposalId,
    });

    await test.service.close();
  });

  it("reconciles terminal recovery through only the retained profile context", async () => {
    const test = await harness();
    const originalStore = new PrivateRedemptionStateStore({
      ...test.storeDependencies,
      profileId: PROFILE_A,
      currentOwner: async () => ({ pid: 1000, processStartIdentity: "boot-a:start-1000" }),
    });
    const prepared = await originalStore.acquirePrepared({
      proposalId: "t".repeat(43),
      idempotencyKey: "aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff",
      accountCheck: { email: "operator@example.com", plan: "pro" },
      selection: { mode: "generic" },
      runtimeIdentity: runtimeIdentity(test.profileA.runtimeContext),
      createdAt: "2026-07-19T11:55:00.000Z",
      expiresAt: "2026-07-19T11:57:00.000Z",
    });
    const dispatchIntent = await originalStore.transitionJournal(
      prepared.proposalId,
      prepared.ownerNonce,
      "prepared",
      {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-19T11:56:00.000Z",
        updatedAt: "2026-07-19T11:56:00.000Z",
      },
    );
    const dispatched = await originalStore.transitionJournal(
      dispatchIntent.proposalId,
      dispatchIntent.ownerNonce,
      "dispatch-intent",
      {
        ...dispatchIntent,
        phase: "dispatched",
        updatedAt: "2026-07-19T11:56:01.000Z",
      },
    );
    await originalStore.transitionJournal(
      dispatched.proposalId,
      dispatched.ownerNonce,
      "dispatched",
      {
        ...dispatched,
        phase: "terminal",
        terminalAt: "2026-07-19T11:56:02.000Z",
        outcome: "reset",
        reconciliation: "pending",
        auditEventId: "a".repeat(43),
        updatedAt: "2026-07-19T11:56:02.000Z",
      },
    );

    await test.service.initializeRecovery("codex");

    expect(test.startSession).toHaveBeenCalledWith(expect.objectContaining({
      runtimeContext: test.profileA.runtimeContext,
    }));
    expect(test.gateway.readRateLimits).toHaveBeenCalledTimes(1);
    expect(test.gateway.consumeResetCredit).not.toHaveBeenCalled();
    await expect(test.service.currentState(PROFILE_A)).resolves.toMatchObject({
      status: "terminal",
      proposalId: prepared.proposalId,
      reconciliation: "reconciled",
    });

    await test.service.close();
  });

  it("preserves legacy global recovery while profile-scoped migration remains active", async () => {
    const test = await harness();
    const prepared = await test.legacyStore.acquirePrepared({
      proposalId: "l".repeat(43),
      idempotencyKey: "aaaaaaaa-bbbb-4ccc-8ddd-222222222222",
      accountCheck: { email: "operator@example.com", plan: "pro" },
      selection: { mode: "generic" },
      runtimeIdentity: runtimeIdentity({
        codexStateRoot: "/home/operator/.codex",
        codexSqliteRoot: "/home/operator/.codex/sqlite",
      }),
      createdAt: "2026-07-19T11:55:00.000Z",
      expiresAt: "2026-07-19T11:57:00.000Z",
    });
    const dispatchIntent = await test.legacyStore.transitionJournal(
      prepared.proposalId,
      prepared.ownerNonce,
      "prepared",
      {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-19T11:56:00.000Z",
        updatedAt: "2026-07-19T11:56:00.000Z",
      },
    );
    await test.legacyStore.transitionJournal(
      dispatchIntent.proposalId,
      dispatchIntent.ownerNonce,
      "dispatch-intent",
      {
        ...dispatchIntent,
        phase: "ambiguous",
        updatedAt: "2026-07-19T11:56:01.000Z",
      },
    );

    await test.service.initializeRecovery("codex");

    await expect(test.service.currentState()).resolves.toMatchObject({
      status: "ambiguous",
      proposalId: prepared.proposalId,
    });
    await expect(test.service.currentState(PROFILE_A)).resolves.toEqual({ status: "not-found" });

    await test.service.close();
  });

  it("contains a broken legacy recovery boundary without blocking healthy profiles", async () => {
    const test = await harness({ failLegacyRecovery: true });

    await expect(test.service.initializeRecovery("codex")).resolves.toBeUndefined();
    await expect(test.service.currentState()).resolves.toMatchObject({
      status: "recovery-required",
      code: "redemption-recovery-required",
    });
    await expect(test.service.prepare("codex", {
      profileId: PROFILE_B,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).resolves.toMatchObject({ status: "prepared" });

    await test.service.close();
  });

  it("rejects creation of a new legacy-global redemption attempt", async () => {
    const test = await harness();

    await expect(test.service.prepare("codex", {
      singleWorkspaceAttested: true,
    } as never)).rejects.toMatchObject({ code: "codex_runtime_incompatible" });
    expect(test.qualifier.qualify).not.toHaveBeenCalled();
    expect(test.gateway.consumeResetCredit).not.toHaveBeenCalled();

    await test.service.close();
  });
});
