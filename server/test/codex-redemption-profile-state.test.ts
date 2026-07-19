import { cp, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  PrivateRedemptionStateStore,
  type AcquirePreparedRedemptionInput,
  type PreparedRedemptionJournal,
  type PrivateRedemptionStateStoreDependencies,
} from "../codex-redemption-private-state.js";
import { makeTempRoot } from "./helpers.js";
import { privateStatePlatformDependencies } from "./private-state-platform.js";

const PROFILE_A = `profile_${"a".repeat(32)}`;
const PROFILE_B = `profile_${"b".repeat(32)}`;

function proposalInput(proposalId: string): AcquirePreparedRedemptionInput {
  return {
    proposalId,
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
    accountCheck: { email: "operator@example.com", plan: "pro" },
    selection: { mode: "generic" },
    runtimeIdentity: {
      canonicalPath: "/opt/codex/bin/codex",
      codexStateRoot: "/private/codex/profile-root",
      codexSqliteRoot: "/private/codex/profile-root/sqlite",
      version: "codex-cli 0.144.4",
      fileIdentity: "1:2:3:4:5",
      schemaHash: "a".repeat(64),
    },
    createdAt: "2026-07-19T12:00:00.000Z",
    expiresAt: "2026-07-19T12:02:00.000Z",
  };
}

async function stateHarness(
  profileId?: string,
  overrides: Partial<PrivateRedemptionStateStoreDependencies> = {},
) {
  const parent = await makeTempRoot();
  const rootPathForTests = path.join(parent, "codex-reset-redemption");
  const dependencies: PrivateRedemptionStateStoreDependencies = {
    ...privateStatePlatformDependencies(),
    rootPathForTests,
    rootAnchorForTests: parent,
    currentOwner: async () => ({ pid: 1234, processStartIdentity: "boot-a:start-42" }),
    ...overrides,
  };
  return {
    parent,
    rootPathForTests,
    dependencies,
    store: new PrivateRedemptionStateStore({ ...dependencies, ...(profileId ? { profileId } : {}) }),
  };
}

function profileRoot(rootPath: string, profileId: string): string {
  return path.join(rootPath, "profiles", profileId);
}

async function transitionToDispatchIntent(
  store: PrivateRedemptionStateStore,
  prepared: PreparedRedemptionJournal,
) {
  return await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
    ...prepared,
    phase: "dispatch-intent",
    dispatchAt: "2026-07-19T12:00:01.000Z",
    updatedAt: "2026-07-19T12:00:01.000Z",
  });
}

async function transitionToAmbiguous(
  store: PrivateRedemptionStateStore,
  prepared: PreparedRedemptionJournal,
) {
  const dispatchIntent = await transitionToDispatchIntent(store, prepared);
  return await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
    ...dispatchIntent,
    phase: "ambiguous",
    updatedAt: "2026-07-19T12:00:02.000Z",
  });
}

async function transitionToTerminal(
  store: PrivateRedemptionStateStore,
  prepared: PreparedRedemptionJournal,
) {
  const dispatchIntent = await transitionToDispatchIntent(store, prepared);
  const dispatched = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
    ...dispatchIntent,
    phase: "dispatched",
    updatedAt: "2026-07-19T12:00:02.000Z",
  });
  return await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatched", {
    ...dispatched,
    phase: "terminal",
    terminalAt: "2026-07-19T12:00:03.000Z",
    outcome: "reset",
    reconciliation: "reconciled",
    auditEventId: "a".repeat(43),
    updatedAt: "2026-07-19T12:00:03.000Z",
  });
}

describe("profile-bound reset-redemption state", () => {
    it("isolates leases by opaque profile namespace and persists only a profile-root/runtime digest", async () => {
      const { rootPathForTests, dependencies } = await stateHarness();
      const profileA = new PrivateRedemptionStateStore({ ...dependencies, profileId: PROFILE_A });
      const profileB = new PrivateRedemptionStateStore({ ...dependencies, profileId: PROFILE_B });

    const [journalA, journalB] = await Promise.all([
      profileA.acquirePrepared(proposalInput("p".repeat(43))),
      profileB.acquirePrepared(proposalInput("q".repeat(43))),
    ]);

    expect(journalA).toMatchObject({
      schemaVersion: 2,
      profileBinding: {
        profileId: PROFILE_A,
        profileRootRuntimeDigest: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      },
    });
    expect(journalB).toMatchObject({
      schemaVersion: 2,
      profileBinding: { profileId: PROFILE_B },
    });
    const persistedA = await readFile(
      path.join(rootPathForTests, "profiles", PROFILE_A, "active-redemption.json"),
      "utf8",
    );
    if (process.platform !== "win32") {
      expect((await stat(path.join(rootPathForTests, "profiles", PROFILE_A))).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(rootPathForTests, "profiles", PROFILE_A, "active-redemption.json"))).mode & 0o777)
        .toBe(0o600);
    }
    expect(persistedA).not.toContain("operator@example.com");
    expect(persistedA).not.toContain('"plan"');
    expect(persistedA).not.toContain("/opt/codex/bin/codex");
      expect(persistedA).not.toContain("/private/codex/profile-root");
      expect(persistedA).not.toContain("quota");
      await transitionToAmbiguous(profileA, journalA);
      await profileB.releasePrepared(journalB.proposalId, journalB.ownerNonce);
      await expect(profileB.acquirePrepared(proposalInput("s".repeat(43)))).resolves.toMatchObject({
        profileBinding: { profileId: PROFILE_B },
      });
      await expect(
      new PrivateRedemptionStateStore({ ...dependencies, profileId: PROFILE_A })
        .acquirePrepared(proposalInput("r".repeat(43))),
    ).rejects.toMatchObject({ code: "redemption-proposal-active" });
  });

    it("fails closed for copied profile state, profile-root replacement, and runtime replacement", async () => {
      const { rootPathForTests, dependencies, store: profileA } = await stateHarness(PROFILE_A);
    const input = proposalInput("p".repeat(43));
    const journal = await profileA.acquirePrepared(input);

    await expect(profileA.verifyRecoveryEvidence(journal, {
      accountCheck: input.accountCheck,
      runtimeIdentity: input.runtimeIdentity,
    })).resolves.toEqual({ accountMatches: true, runtimeMatches: true, profileMatches: true });
    await expect(profileA.verifyRecoveryEvidence(journal, {
      accountCheck: input.accountCheck,
      runtimeIdentity: { ...input.runtimeIdentity, codexStateRoot: "/replacement/profile-root" },
    })).resolves.toEqual({ accountMatches: true, runtimeMatches: false, profileMatches: false });
    await expect(profileA.verifyRecoveryEvidence(journal, {
      accountCheck: input.accountCheck,
      runtimeIdentity: { ...input.runtimeIdentity, version: "codex-cli replacement" },
    })).resolves.toEqual({ accountMatches: true, runtimeMatches: false, profileMatches: false });

    await cp(
      path.join(rootPathForTests, "profiles", PROFILE_A),
      path.join(rootPathForTests, "profiles", PROFILE_B),
      { recursive: true },
    );
    const profileB = new PrivateRedemptionStateStore({ ...dependencies, profileId: PROFILE_B });
    await expect(profileB.initializeRecovery()).resolves.toEqual({ status: "recovery-required" });
  });

    it("binds an ambiguous retry claim to the same profile and private digest", async () => {
      const { rootPathForTests, store } = await stateHarness(PROFILE_A);
      const prepared = await store.acquirePrepared(proposalInput("p".repeat(43)));
      await transitionToAmbiguous(store, prepared);

    await expect(store.claimAmbiguousRetry(prepared.proposalId)).resolves.toMatchObject({
      status: "claimed",
      journal: { profileBinding: prepared.profileBinding },
    });
    const persisted = JSON.parse(await readFile(
      path.join(rootPathForTests, "profiles", PROFILE_A, "active-redemption.retry-claim.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(persisted).toMatchObject({
      schemaVersion: 2,
      proposalId: prepared.proposalId,
      profileBinding: prepared.profileBinding,
    });
    expect(JSON.stringify(persisted)).not.toContain("operator@example.com");
    expect(JSON.stringify(persisted)).not.toContain("/private/codex/profile-root");
  });

    it("upgrades a terminal tombstone to the active profile binding before lease release", async () => {
      const { store } = await stateHarness(PROFILE_A);
      const prepared = await store.acquirePrepared(proposalInput("p".repeat(43)));
      await transitionToTerminal(store, prepared);
    const tombstone = {
      schemaVersion: 1 as const,
      proposalId: prepared.proposalId,
      selectionMode: "generic" as const,
      outcome: "reset" as const,
      reconciliation: "reconciled" as const,
      auditEventId: "a".repeat(43),
      message: "Usage limits reset. Checking current usage…",
      createdAt: "2026-07-19T12:00:03.000Z",
      expiresAt: "2026-07-19T12:10:03.000Z",
    };

    await store.publishTombstone(tombstone);

    await expect(store.readTombstone(prepared.proposalId)).resolves.toMatchObject({
      schemaVersion: 2,
      profileBinding: prepared.profileBinding,
    });
      await expect(store.releaseTerminal(prepared.proposalId, prepared.ownerNonce, tombstone.auditEventId))
        .resolves.toBeUndefined();
    });

    it("allows deletion only after the active profile-bound journal and retry claim are gone", async () => {
      const { store } = await stateHarness(PROFILE_A, {
        inspectOwner: async () => "alive" as const,
        now: () => Date.parse("2026-07-19T12:05:00.000Z"),
      });
      await expect(store.deletionDisposition()).resolves.toBe("safe");
      const prepared = await store.acquirePrepared(proposalInput("p".repeat(43)));
      await expect(store.deletionDisposition()).resolves.toBe("blocked");
      await transitionToTerminal(store, prepared);
      const tombstone = {
        schemaVersion: 1 as const,
        proposalId: prepared.proposalId,
        selectionMode: "generic" as const,
        outcome: "reset" as const,
        reconciliation: "reconciled" as const,
        auditEventId: "a".repeat(43),
        message: "Usage limits reset. Checking current usage…",
        createdAt: "2026-07-19T12:00:03.000Z",
        expiresAt: "2026-07-19T12:10:03.000Z",
      };
      await store.publishTombstone(tombstone);
      await expect(store.deletionDisposition()).resolves.toBe("blocked");

      await store.releaseTerminal(prepared.proposalId, prepared.ownerNonce, tombstone.auditEventId);

      await expect(store.deletionDisposition()).resolves.toBe("safe");
      await expect(store.readPublicState()).resolves.toMatchObject({ status: "terminal" });
    });

    it("keeps legacy current-account state recoverable outside profile namespaces", async () => {
      const { dependencies, store: legacyStore } = await stateHarness(undefined, {
        inspectOwner: async () => "alive" as const,
      });
    const input = proposalInput("p".repeat(43));
    const journal = await legacyStore.acquirePrepared(input);

    expect(journal).toMatchObject({ schemaVersion: 1 });
    expect(journal).not.toHaveProperty("profileBinding");
    await expect(new PrivateRedemptionStateStore(dependencies).initializeRecovery()).resolves.toMatchObject({
      status: "prepared",
      journal: { proposalId: journal.proposalId, schemaVersion: 1 },
    });
    await expect(legacyStore.verifyRecoveryEvidence(journal, {
      accountCheck: input.accountCheck,
      runtimeIdentity: input.runtimeIdentity,
    })).resolves.toEqual({ accountMatches: true, runtimeMatches: true });
    await expect(
      new PrivateRedemptionStateStore({ ...dependencies, profileId: PROFILE_A }).initializeRecovery(),
      ).resolves.toEqual({ status: "idle" });
    });

    it("rejects retry claims and recovery cleanup journals copied from another profile", async () => {
      const now = () => Date.parse("2026-07-19T12:03:00.000Z");
      const { rootPathForTests, dependencies, store } = await stateHarness(PROFILE_B, {
        now,
        inspectOwner: async () => "alive" as const,
      });
      const prepared = await store.acquirePrepared(proposalInput("p".repeat(43)));
      await transitionToAmbiguous(store, prepared);
      const root = profileRoot(rootPathForTests, PROFILE_B);
      await writeFile(path.join(root, "active-redemption.retry-claim.json"), `${JSON.stringify({
        schemaVersion: 2,
        proposalId: prepared.proposalId,
        claimOwnerNonce: "c".repeat(43),
        owner: { pid: 1234, processStartIdentity: "boot-a:start-42" },
        createdAt: "2026-07-19T12:02:30.000Z",
        profileBinding: { ...prepared.profileBinding, profileId: PROFILE_A },
      })}\n`, { mode: 0o600 });
      await expect(new PrivateRedemptionStateStore({ ...dependencies, profileId: PROFILE_B }).initializeRecovery())
        .resolves.toEqual({ status: "recovery-required" });

      const cleanupHarness = await stateHarness(PROFILE_B, {
        now,
        inspectOwner: async () => "dead" as const,
      });
      const cleanupPrepared = await cleanupHarness.store.acquirePrepared(proposalInput("q".repeat(43)));
      const cleanupRoot = profileRoot(cleanupHarness.rootPathForTests, PROFILE_B);
      const activePath = path.join(cleanupRoot, "active-redemption.json");
      const cleanupPath = path.join(cleanupRoot, ".active-redemption.foreign.cleanup");
      await rename(activePath, cleanupPath);
      await writeFile(cleanupPath, `${JSON.stringify({
        ...cleanupPrepared,
        profileBinding: { ...cleanupPrepared.profileBinding, profileId: PROFILE_A },
      })}\n`, { mode: 0o600 });
      await expect(
        new PrivateRedemptionStateStore({ ...cleanupHarness.dependencies, profileId: PROFILE_B }).initializeRecovery(),
      ).resolves.toEqual({ status: "recovery-required" });
    });

    it("applies and revalidates Windows DACL protection at the profile namespace", async () => {
    const parent = await makeTempRoot();
    const rootPathForTests = path.join(parent, "codex-reset-redemption");
    const profileRoot = path.join(rootPathForTests, "profiles", PROFILE_A);
    const windowsSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async () => {}),
    };
    const store = new PrivateRedemptionStateStore({
      platform: "win32",
      rootPathForTests,
      rootAnchorForTests: parent,
      profileId: PROFILE_A,
      currentOwner: async () => ({ pid: 1234, processStartIdentity: "boot-a:start-42" }),
      windowsSecurity,
    });

    await store.acquirePrepared(proposalInput("p".repeat(43)));

    expect(windowsSecurity.secureCreatedDirectory).toHaveBeenCalledWith(profileRoot);
    expect(windowsSecurity.verifyPrivatePath).toHaveBeenCalledWith(profileRoot, true);
    expect(windowsSecurity.verifyPrivatePath).toHaveBeenCalledWith(
      path.join(profileRoot, "active-redemption.json"),
      false,
    );
  });
});
