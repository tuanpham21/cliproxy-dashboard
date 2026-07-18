import { readFile, realpath, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { releaseRetryClaim as releasePrivateRetryClaim } from "../codex-redemption-private-claim.js";
import { parseRedemptionJournal } from "../codex-redemption-journal.js";
import {
  PrivateRedemptionStateStore,
  type AcquirePreparedRedemptionInput,
} from "../codex-redemption-private-state.js";
import { transitionJournal as transitionPrivateJournal } from "../codex-redemption-private-terminal.js";
import { makeTempRoot } from "./helpers.js";
import { PRIVATE_STATE_TEST_PLATFORM, privateStatePlatformDependencies } from "./private-state-platform.js";

const preparedInput: AcquirePreparedRedemptionInput = {
  proposalId: "p".repeat(43),
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
  accountCheck: { email: "operator@example.com", plan: "pro" },
  selection: { mode: "specific", creditId: "credit-secret-id" },
  runtimeIdentity: {
      canonicalPath: "/opt/codex/bin/codex",
      codexStateRoot: "/home/operator/.codex",
      codexSqliteRoot: "/home/operator/.codex/sqlite",
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4:5",
    schemaHash: "a".repeat(64),
  },
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-16T12:02:00.000Z",
};

async function recoveryHarness(ownerStatus: "alive" | "dead" | "pid-reused" | "unverifiable" = "dead") {
  const parent = await makeTempRoot();
  const rootPathForTests = path.join(parent, "state with spaces", "codex-reset-redemption");
  const dependencies = {
    ...privateStatePlatformDependencies(),
    rootPathForTests,
    rootAnchorForTests: parent,
    currentOwner: async () => ({ pid: 2000, processStartIdentity: "boot-a:start-2000" }),
    inspectOwner: async (owner: { pid: number }) => owner.pid === 1000 ? ownerStatus : "alive" as const,
    now: () => Date.parse("2026-07-16T12:03:00.000Z"),
  };
  return {
    parent,
    rootPathForTests,
    store: new PrivateRedemptionStateStore(dependencies),
    originalStore: new PrivateRedemptionStateStore({
      ...dependencies,
      currentOwner: async () => ({ pid: 1000, processStartIdentity: "boot-a:start-1000" }),
    }),
    secondStore: new PrivateRedemptionStateStore({
      ...dependencies,
      currentOwner: async () => ({ pid: 2001, processStartIdentity: "boot-a:start-2001" }),
    }),
  };
}

  describe("reset-redemption startup recovery", () => {
  it("promotes restart dispatch intent to ambiguous before serving state", async () => {
    const { originalStore, secondStore } = await recoveryHarness();
    const prepared = await originalStore.acquirePrepared(preparedInput);
    await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
      ...prepared,
      phase: "dispatch-intent",
      dispatchAt: "2026-07-16T12:00:01.000Z",
      updatedAt: "2026-07-16T12:00:01.000Z",
    });

    await expect(secondStore.initializeRecovery()).resolves.toMatchObject({ status: "ambiguous" });
    await expect(secondStore.readPublicState(prepared.proposalId)).resolves.toMatchObject({
      status: "ambiguous",
      proposalId: prepared.proposalId,
      });
    });

    it("keeps a live owner's dispatch intent in processing state", async () => {
      const { originalStore, secondStore } = await recoveryHarness("alive");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-16T12:00:01.000Z",
        updatedAt: "2026-07-16T12:00:01.000Z",
      });

      await expect(secondStore.initializeRecovery()).resolves.toMatchObject({
        status: "processing",
        journal: { phase: "dispatch-intent" },
      });
      await expect(secondStore.readPublicState(prepared.proposalId)).resolves.toMatchObject({
        status: "processing",
        phase: "dispatch-intent",
      });
    });

    it.each(["dead", "pid-reused"] as const)(
    "reclaims expired prepared state only after owner is conclusively %s",
    async (ownerStatus) => {
      const { originalStore, secondStore, rootPathForTests } = await recoveryHarness(ownerStatus);
      await originalStore.acquirePrepared(preparedInput);

      await expect(secondStore.initializeRecovery()).resolves.toEqual({ status: "idle" });
      await expect(stat(path.join(rootPathForTests, "active-redemption.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(secondStore.acquirePrepared({ ...preparedInput, proposalId: "q".repeat(43) })).resolves.toMatchObject({
        phase: "prepared",
        proposalId: "q".repeat(43),
      });
    },
  );

  it("lets one atomic source rename win between simultaneous prepared reclaimers", async () => {
    const { originalStore, store, secondStore, rootPathForTests } = await recoveryHarness("dead");
    await originalStore.acquirePrepared(preparedInput);

    const results = await Promise.all([
      store.initializeRecovery(),
      secondStore.initializeRecovery(),
    ]);

      expect(results.every((result) => result.status === "idle" || result.status === "recovery-required")).toBe(true);
      await expect(store.initializeRecovery()).resolves.toEqual({ status: "idle" });
      await expect(secondStore.initializeRecovery()).resolves.toEqual({ status: "idle" });
    await expect(stat(path.join(rootPathForTests, "active-redemption.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.acquirePrepared({ ...preparedInput, proposalId: "q".repeat(43) })).resolves.toMatchObject({
      proposalId: "q".repeat(43),
    });
  });

    it("cleans a verified stale reclaim file without deleting replacement active state", async () => {
      const { originalStore, secondStore, rootPathForTests } = await recoveryHarness("dead");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const cleanupPath = path.join(rootPathForTests, ".active-redemption.stale.cleanup");
      await rename(path.join(rootPathForTests, "active-redemption.json"), cleanupPath);
      await utimes(cleanupPath, new Date("2026-07-16T12:00:00.000Z"), new Date("2026-07-16T12:00:00.000Z"));
      const replacement = {
        ...prepared,
        proposalId: "q".repeat(43),
        ownerNonce: "r".repeat(43),
        owner: { pid: 2000, processStartIdentity: "boot-a:start-2000" },
        idempotencyKey: "22222222-3333-4444-8555-666666666666",
      };
      await writeFile(
        path.join(rootPathForTests, "active-redemption.json"),
        `${JSON.stringify(replacement)}\n`,
        { mode: 0o600 },
      );

    await expect(secondStore.initializeRecovery()).resolves.toMatchObject({
      status: "prepared",
      journal: { proposalId: replacement.proposalId },
    });
    await expect(stat(cleanupPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(secondStore.readPublicState(replacement.proposalId)).resolves.toMatchObject({
        status: "prepared",
        proposalId: replacement.proposalId,
      });
    });

    it("cleans a byte-identical active-journal cleanup left by restore crash", async () => {
      const { originalStore, secondStore, rootPathForTests } = await recoveryHarness("alive");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const cleanupPath = path.join(rootPathForTests, ".active-redemption.restore-crash.cleanup");
      await writeFile(cleanupPath, `${JSON.stringify(prepared)}\n`, { mode: 0o600 });

      await expect(secondStore.initializeRecovery()).resolves.toMatchObject({
        status: "prepared",
        journal: { proposalId: prepared.proposalId },
      });
      await expect(stat(cleanupPath)).rejects.toMatchObject({ code: "ENOENT" });
    });

  it.each([
    ["alive", "prepared"],
    ["unverifiable", "recovery-required"],
  ] as const)("keeps expired prepared state blocked when owner is %s", async (ownerStatus, expectedStatus) => {
    const { originalStore, secondStore, rootPathForTests } = await recoveryHarness(ownerStatus);
    await originalStore.acquirePrepared(preparedInput);

    await expect(secondStore.initializeRecovery()).resolves.toMatchObject({ status: expectedStatus });
    await expect(stat(path.join(rootPathForTests, "active-redemption.json"))).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("does not reclaim a nonexpired prepared proposal even when its owner is dead", async () => {
    const { originalStore, parent, rootPathForTests } = await recoveryHarness("dead");
    await originalStore.acquirePrepared(preparedInput);
    const earlyRecovery = new PrivateRedemptionStateStore({
      ...privateStatePlatformDependencies(),
      rootPathForTests,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 3000, processStartIdentity: "boot-a:start-3000" }),
      inspectOwner: async () => "dead",
      now: () => Date.parse("2026-07-16T12:01:00.000Z"),
    });

    await expect(earlyRecovery.initializeRecovery()).resolves.toMatchObject({ status: "prepared" });
    await expect(stat(path.join(rootPathForTests, "active-redemption.json"))).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("never reclaims ambiguous state regardless of age or dead original owner", async () => {
    const { originalStore, secondStore, rootPathForTests } = await recoveryHarness("dead");
    const prepared = await originalStore.acquirePrepared(preparedInput);
    const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
      ...prepared,
      phase: "dispatch-intent",
      dispatchAt: "2026-07-16T12:00:01.000Z",
      updatedAt: "2026-07-16T12:00:01.000Z",
    });
    await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
      ...intent,
      phase: "ambiguous",
      updatedAt: "2026-07-16T12:00:02.000Z",
    });

    await expect(secondStore.initializeRecovery()).resolves.toMatchObject({ status: "ambiguous" });
    await expect(stat(path.join(rootPathForTests, "active-redemption.json"))).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("allows exactly one cross-process retry claimant and retains the exact logical attempt", async () => {
    const { originalStore, store, secondStore } = await recoveryHarness("dead");
    const prepared = await originalStore.acquirePrepared(preparedInput);
    const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
      ...prepared,
      phase: "dispatch-intent",
      dispatchAt: "2026-07-16T12:00:01.000Z",
      updatedAt: "2026-07-16T12:00:01.000Z",
    });
    await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
      ...intent,
      phase: "ambiguous",
      updatedAt: "2026-07-16T12:00:02.000Z",
    });

    const results = await Promise.all([
      store.claimAmbiguousRetry(prepared.proposalId),
      secondStore.claimAmbiguousRetry(prepared.proposalId),
    ]);
    const claimed = results.find((result) => result.status === "claimed");
    expect(results.filter((result) => result.status === "claimed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "busy")).toHaveLength(1);
    expect(claimed).toMatchObject({
      status: "claimed",
      journal: {
        idempotencyKey: preparedInput.idempotencyKey,
        selection: preparedInput.selection,
      },
    });
    if (!claimed || claimed.status !== "claimed") throw new Error("retry claim missing");

    const winner = results[0] === claimed ? store : secondStore;
    const loser = winner === store ? secondStore : store;
    await winner.releaseRetryClaim(prepared.proposalId, claimed.claimOwnerNonce);
      await expect(loser.claimAmbiguousRetry(prepared.proposalId)).resolves.toMatchObject({ status: "claimed" });
    });

    it("preserves a replacement retry claimant during stale-claim reclamation", async () => {
      const { originalStore, store: staleOwnerStore, parent, rootPathForTests } = await recoveryHarness("dead");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-16T12:00:01.000Z",
        updatedAt: "2026-07-16T12:00:01.000Z",
      });
      await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
        ...intent,
        phase: "ambiguous",
        updatedAt: "2026-07-16T12:00:02.000Z",
      });
      const staleClaim = await staleOwnerStore.claimAmbiguousRetry(prepared.proposalId);
      if (staleClaim.status !== "claimed") throw new Error("stale retry claim missing");

      const replacementStore = new PrivateRedemptionStateStore({
        ...privateStatePlatformDependencies(),
        rootPathForTests,
        rootAnchorForTests: parent,
        currentOwner: async () => ({ pid: 3000, processStartIdentity: "boot-a:start-3000" }),
        inspectOwner: async (owner) => owner.pid === 3000 ? "alive" : "dead",
        now: () => Date.parse("2026-07-16T12:04:00.000Z"),
      });
      let replacementClaim: Awaited<ReturnType<typeof replacementStore.claimAmbiguousRetry>> | null = null;
      const racingStore = new PrivateRedemptionStateStore({
        ...privateStatePlatformDependencies(),
        rootPathForTests,
        rootAnchorForTests: parent,
        currentOwner: async () => ({ pid: 4000, processStartIdentity: "boot-a:start-4000" }),
        inspectOwner: async (owner) => {
          if (owner.pid === 2000) {
            await staleOwnerStore.releaseRetryClaim(prepared.proposalId, staleClaim.claimOwnerNonce);
            replacementClaim = await replacementStore.claimAmbiguousRetry(prepared.proposalId);
            return "dead";
          }
          return owner.pid === 3000 ? "alive" : "dead";
        },
        now: () => Date.parse("2026-07-16T12:04:00.000Z"),
      });

      await expect(racingStore.claimAmbiguousRetry(prepared.proposalId)).rejects.toThrow(
        "Reset redemption recovery state requires local repair.",
      );
      expect(replacementClaim).toMatchObject({ status: "claimed" });
      await expect(racingStore.readPublicState(prepared.proposalId)).resolves.toMatchObject({
        status: "processing",
        phase: "retrying",
      });
      if (!replacementClaim || replacementClaim.status !== "claimed") throw new Error("replacement retry claim missing");
      await replacementStore.releaseRetryClaim(prepared.proposalId, replacementClaim.claimOwnerNonce);
    });

    it("reclaims a dead retry claimant without unlocking the ambiguous attempt", async () => {
    const { originalStore, store, parent, rootPathForTests } = await recoveryHarness("dead");
    const prepared = await originalStore.acquirePrepared(preparedInput);
    const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
      ...prepared,
      phase: "dispatch-intent",
      dispatchAt: "2026-07-16T12:00:01.000Z",
      updatedAt: "2026-07-16T12:00:01.000Z",
    });
    await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
      ...intent,
      phase: "ambiguous",
      updatedAt: "2026-07-16T12:00:02.000Z",
    });
    await expect(store.claimAmbiguousRetry(prepared.proposalId)).resolves.toMatchObject({ status: "claimed" });
    const restarted = new PrivateRedemptionStateStore({
      ...privateStatePlatformDependencies(),
      rootPathForTests,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 3000, processStartIdentity: "boot-a:start-3000" }),
      inspectOwner: async (owner) => owner.pid === 3000 ? "alive" : "dead",
      now: () => Date.parse("2026-07-16T12:04:00.000Z"),
    });

    await expect(restarted.initializeRecovery()).resolves.toMatchObject({ status: "ambiguous" });
    await expect(restarted.readPublicState(prepared.proposalId)).resolves.toMatchObject({
      status: "ambiguous",
    });
      await expect(restarted.claimAmbiguousRetry(prepared.proposalId)).resolves.toMatchObject({ status: "claimed" });
    });

    it("discovers a retry claimant death and permits same-key reclaim without restart", async () => {
      const { originalStore, store: claimantStore, parent, rootPathForTests } = await recoveryHarness("dead");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-16T12:00:01.000Z",
        updatedAt: "2026-07-16T12:00:01.000Z",
      });
      await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
        ...intent,
        phase: "ambiguous",
        updatedAt: "2026-07-16T12:00:02.000Z",
      });
      await expect(claimantStore.claimAmbiguousRetry(prepared.proposalId)).resolves.toMatchObject({ status: "claimed" });
      let claimantAlive = true;
      const observerStore = new PrivateRedemptionStateStore({
        ...privateStatePlatformDependencies(),
        rootPathForTests,
        rootAnchorForTests: parent,
        currentOwner: async () => ({ pid: 3000, processStartIdentity: "boot-a:start-3000" }),
        inspectOwner: async (owner) => owner.pid === 2000 && claimantAlive ? "alive" : "dead",
        now: () => Date.parse("2026-07-16T12:04:00.000Z"),
      });

      await expect(observerStore.readPublicState(prepared.proposalId)).resolves.toMatchObject({
        status: "processing",
        phase: "retrying",
      });
      claimantAlive = false;
      await expect(observerStore.readPublicState(prepared.proposalId)).resolves.toMatchObject({ status: "ambiguous" });
      await expect(observerStore.claimAmbiguousRetry(prepared.proposalId)).resolves.toMatchObject({
        status: "claimed",
        journal: { idempotencyKey: preparedInput.idempotencyKey },
      });
    });

    it("suppresses terminal startup recovery while the retry claimant is alive", async () => {
      const { originalStore, store: claimantStore, parent, rootPathForTests } = await recoveryHarness("dead");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-16T12:00:01.000Z",
        updatedAt: "2026-07-16T12:00:01.000Z",
      });
      const ambiguousJournal = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
        ...intent,
        phase: "ambiguous",
        updatedAt: "2026-07-16T12:00:02.000Z",
      });
      await claimantStore.claimAmbiguousRetry(prepared.proposalId);
      const terminal = await claimantStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "ambiguous", {
        ...ambiguousJournal,
        phase: "terminal",
        terminalAt: "2026-07-16T12:03:00.000Z",
        outcome: "reset",
        reconciliation: "pending",
        auditEventId: "a".repeat(43),
        updatedAt: "2026-07-16T12:03:00.000Z",
      });
      const observerStore = new PrivateRedemptionStateStore({
        ...privateStatePlatformDependencies(),
        rootPathForTests,
        rootAnchorForTests: parent,
        currentOwner: async () => ({ pid: 3000, processStartIdentity: "boot-a:start-3000" }),
        inspectOwner: async (owner) => owner.pid === 2000 ? "alive" : "dead",
        now: () => Date.parse("2026-07-16T12:04:00.000Z"),
      });

      await expect(observerStore.initializeRecovery()).resolves.toMatchObject({
        status: "processing",
        journal: { phase: "terminal" },
      });
      const reconciled = await claimantStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "terminal", {
        ...terminal,
        reconciliation: "reconciled",
        updatedAt: "2026-07-16T12:03:01.000Z",
      });
      await claimantStore.publishTombstone({
        schemaVersion: 1,
        proposalId: prepared.proposalId,
        selectionMode: "specific",
        outcome: "reset",
        reconciliation: "reconciled",
        auditEventId: "a".repeat(43),
        message: "Usage limits reset. Checking current usage…",
        createdAt: "2026-07-16T12:03:01.000Z",
        expiresAt: "2026-07-16T12:13:01.000Z",
      });
      await claimantStore.releaseTerminal(prepared.proposalId, prepared.ownerNonce, reconciled.auditEventId);
      await expect(observerStore.initializeRecovery()).resolves.toEqual({ status: "retry-finalizing" });
    });

    it("treats retry-claim release as complete when unlink succeeded before directory sync failed", async () => {
      const { originalStore, store, rootPathForTests } = await recoveryHarness("dead");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
        ...prepared,
        phase: "dispatch-intent",
        dispatchAt: "2026-07-16T12:00:01.000Z",
        updatedAt: "2026-07-16T12:00:01.000Z",
      });
      await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
        ...intent,
        phase: "ambiguous",
        updatedAt: "2026-07-16T12:00:02.000Z",
      });
      const claim = await store.claimAmbiguousRetry(prepared.proposalId);
      if (claim.status !== "claimed") throw new Error("retry claim missing");
      let syncCalls = 0;
      const dependencies = {
        context: { rootPath: rootPathForTests, platform: PRIVATE_STATE_TEST_PLATFORM },
        canonicalRoot: await realpath(rootPathForTests),
        currentOwner: async () => ({ pid: 2000, processStartIdentity: "boot-a:start-2000" }),
        inspectOwner: async () => "alive" as const,
        randomBytes: () => Buffer.alloc(32, 1),
        randomUUID: () => "release-retry-claim",
        now: () => Date.parse("2026-07-16T12:04:00.000Z"),
        syncDirectory: async () => {
          syncCalls += 1;
          if (syncCalls === 1) throw new Error("directory sync failed");
        },
        createError: () => new Error("Reset redemption recovery state requires local repair."),
      };

      await expect(releasePrivateRetryClaim(
        dependencies,
        prepared.proposalId,
        claim.claimOwnerNonce,
      )).resolves.toBeUndefined();
      await expect(releasePrivateRetryClaim(
        dependencies,
        prepared.proposalId,
        claim.claimOwnerNonce,
      )).resolves.toBeUndefined();
      await expect(store.readPublicState(prepared.proposalId)).resolves.toMatchObject({ status: "ambiguous" });
    });

    it("never overwrites a replacement active journal during transition", async () => {
      const { originalStore, rootPathForTests } = await recoveryHarness("dead");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const next = {
        ...prepared,
        phase: "dispatch-intent" as const,
        dispatchAt: "2026-07-16T12:00:01.000Z",
        updatedAt: "2026-07-16T12:00:01.000Z",
      };
      const replacement = {
        ...prepared,
        proposalId: "q".repeat(43),
        ownerNonce: "r".repeat(43),
        idempotencyKey: "22222222-3333-4444-8555-666666666666",
      };
      let syncCalls = 0;

      await expect(transitionPrivateJournal({
        context: { rootPath: rootPathForTests, platform: PRIVATE_STATE_TEST_PLATFORM },
        canonicalRoot: await realpath(rootPathForTests),
        randomUUID: () => "transition-race",
        syncDirectory: async () => {
          syncCalls += 1;
          if (syncCalls === 1) {
            await writeFile(
              path.join(rootPathForTests, "active-redemption.json"),
              `${JSON.stringify(replacement)}\n`,
              { mode: 0o600 },
            );
          }
        },
        createError: () => new Error("Reset redemption recovery state requires local repair."),
        now: () => Date.parse("2026-07-16T12:01:00.000Z"),
      }, prepared.proposalId, prepared.ownerNonce, "prepared", prepared, next)).rejects.toThrow(
        "Reset redemption recovery state requires local repair.",
      );
      const authoritative = parseRedemptionJournal(JSON.parse(
        (await readFile(path.join(rootPathForTests, "active-redemption.json"))).toString("utf8"),
      ) as unknown);
      expect(authoritative).toMatchObject({ proposalId: replacement.proposalId, ownerNonce: replacement.ownerNonce });
    });

    it("completes a durable transition when a recovery observer removes its predecessor cleanup", async () => {
      const { originalStore, rootPathForTests } = await recoveryHarness("dead");
      const prepared = await originalStore.acquirePrepared(preparedInput);
      const next = {
        ...prepared,
        phase: "dispatch-intent" as const,
        dispatchAt: "2026-07-16T12:00:01.000Z",
        updatedAt: "2026-07-16T12:00:01.000Z",
      };
      let syncCalls = 0;

      await expect(transitionPrivateJournal({
        context: { rootPath: rootPathForTests, platform: PRIVATE_STATE_TEST_PLATFORM },
        canonicalRoot: await realpath(rootPathForTests),
        randomUUID: () => "observer-cleanup-race",
        syncDirectory: async () => {
          syncCalls += 1;
          if (syncCalls === 2) {
            await unlink(path.join(rootPathForTests, ".active-redemption.observer-cleanup-race.cleanup"));
          }
        },
        createError: () => new Error("Reset redemption recovery state requires local repair."),
        now: () => Date.parse("2026-07-16T12:01:00.000Z"),
      }, prepared.proposalId, prepared.ownerNonce, "prepared", prepared, next)).resolves.toEqual(next);
      const authoritative = JSON.parse(
        (await readFile(path.join(rootPathForTests, "active-redemption.json"))).toString("utf8"),
      ) as unknown;
      expect(authoritative).toEqual(next);
    });
  });
