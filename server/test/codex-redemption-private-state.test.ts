import { chmod, link, lstat, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CodexRedemptionPrivateStateError,
  PrivateRedemptionStateStore,
  type AcquirePreparedRedemptionInput,
} from "../codex-redemption-private-state.js";
import { makeTempRoot } from "./helpers.js";
import { privateStatePlatformDependencies } from "./private-state-platform.js";

const proposalInput: AcquirePreparedRedemptionInput = {
  proposalId: "p".repeat(43),
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
  accountCheck: { email: "operator@example.com", plan: "pro" },
  selection: { mode: "specific", creditId: "credit-secret-id" },
  runtimeIdentity: {
    canonicalPath: "/opt/codex/bin/codex",
    codexStateRoot: "/home/operator/.codex",
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4:5",
    schemaHash: "a".repeat(64),
  },
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-16T12:02:00.000Z",
};

async function storeHarness(overrides: Partial<ConstructorParameters<typeof PrivateRedemptionStateStore>[0]> = {}) {
  const parent = await makeTempRoot();
  const rootPathForTests = path.join(parent, "state with spaces", "codex-reset-redemption");
  const currentOwner = vi.fn(async () => ({ pid: 1234, processStartIdentity: "boot-a:start-42" }));
  const store = new PrivateRedemptionStateStore({
    ...privateStatePlatformDependencies(),
    rootPathForTests,
    rootAnchorForTests: parent,
    currentOwner,
    ...overrides,
  });
  return { store, parent, rootPathForTests, currentOwner };
}

describe("private reset-redemption state", () => {
  it("creates owner-private key and prepared journal without forbidden display data", async () => {
    const { store, rootPathForTests } = await storeHarness();

    const journal = await store.acquirePrepared(proposalInput);

    expect(journal).toMatchObject({
      schemaVersion: 1,
      phase: "prepared",
      proposalId: proposalInput.proposalId,
      selection: { mode: "specific", creditId: "credit-secret-id" },
      owner: { pid: 1234, processStartIdentity: "boot-a:start-42" },
    });
    expect(journal.ownerNonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(journal.accountCheckDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(journal.runtimeIdentity.canonicalPathDigest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(journal.runtimeIdentity).not.toHaveProperty("canonicalPath");

    const rootMode = (await stat(rootPathForTests)).mode & 0o777;
    const keyPath = path.join(rootPathForTests, "account-digest.key");
    const journalPath = path.join(rootPathForTests, "active-redemption.json");
    if (process.platform !== "win32") {
      expect(rootMode).toBe(0o700);
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(keyPath)).size).toBe(32);
    if (process.platform !== "win32") expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    expect((await stat(journalPath)).nlink).toBe(1);

    const persisted = await readFile(journalPath, "utf8");
    expect(persisted).not.toContain("operator@example.com");
    expect(persisted).not.toContain('"plan"');
    expect(persisted).not.toContain("/opt/codex/bin/codex");
    expect(persisted).not.toContain("quota");
  });

  it("uses the filesystem lease to allow exactly one simultaneous proposal", async () => {
    const { parent, rootPathForTests } = await storeHarness();
    const first = new PrivateRedemptionStateStore({
      ...privateStatePlatformDependencies(),
      rootPathForTests,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 1001, processStartIdentity: "boot-a:start-1" }),
    });
    const second = new PrivateRedemptionStateStore({
      ...privateStatePlatformDependencies(),
      rootPathForTests,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 1002, processStartIdentity: "boot-a:start-2" }),
    });
    expect(parent).toBeTruthy();

    const results = await Promise.allSettled([
      first.acquirePrepared(proposalInput),
      second.acquirePrepared({ ...proposalInput, proposalId: "q".repeat(43) }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.objectContaining({ code: "redemption-proposal-active" }),
    });
    const active = JSON.parse(await readFile(path.join(rootPathForTests, "active-redemption.json"), "utf8")) as {
      proposalId: string;
    };
    expect([proposalInput.proposalId, "q".repeat(43)]).toContain(active.proposalId);
  });

  it("fails closed with a stable code when process-start identity is unavailable", async () => {
    const { store } = await storeHarness({
      currentOwner: async () => { throw new Error("process start denied"); },
    });

    await expect(store.acquirePrepared(proposalInput)).rejects.toMatchObject({
      code: "redemption-private-state-unavailable",
    });
  });

  it("treats the active journal's publication hard link as an active lease", async () => {
    const { store, rootPathForTests } = await storeHarness();
    await store.acquirePrepared(proposalInput);
    const activePath = path.join(rootPathForTests, "active-redemption.json");
    await link(activePath, path.join(rootPathForTests, ".active-redemption.publication.candidate"));

    await expect(store.acquirePrepared({ ...proposalInput, proposalId: "q".repeat(43) })).rejects.toMatchObject({
      code: "redemption-proposal-active",
    });
  });

  it("releases only the matching prepared owner and leaves the digest key", async () => {
    const { store, rootPathForTests } = await storeHarness();
    const journal = await store.acquirePrepared(proposalInput);

    await expect(store.releasePrepared(journal.proposalId, "wrong-owner")).rejects.toMatchObject({
      code: "redemption-proposal-owner-mismatch",
    });
    await store.releasePrepared(journal.proposalId, journal.ownerNonce);

    await expect(lstat(path.join(rootPathForTests, "active-redemption.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(path.join(rootPathForTests, "account-digest.key"))).size).toBe(32);
    await expect(store.readPublicState(journal.proposalId)).resolves.toEqual({ status: "not-found" });
  });

  it("fails closed for missing or corrupt key around active state", async () => {
    const { store, rootPathForTests } = await storeHarness();
    const journal = await store.acquirePrepared(proposalInput);
    const keyPath = path.join(rootPathForTests, "account-digest.key");

    await unlink(keyPath);
    await expect(store.readPublicState(journal.proposalId)).resolves.toMatchObject({
      status: "recovery-required",
      code: "redemption-recovery-required",
    });

    await writeFile(keyPath, "short", { mode: 0o600 });
    await expect(store.acquirePrepared({ ...proposalInput, proposalId: "r".repeat(43) })).rejects.toMatchObject({
      code: "redemption-recovery-required",
    });
  });

  it("keeps polling reads side-effect-free when no root exists", async () => {
    const { store, rootPathForTests, currentOwner } = await storeHarness();

    await expect(store.readPublicState("missing-proposal")).resolves.toEqual({ status: "not-found" });
    await expect(lstat(rootPathForTests)).rejects.toMatchObject({ code: "ENOENT" });
    expect(currentOwner).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects symlink roots and symlinked ancestors", async () => {
    const parent = await makeTempRoot();
    const target = path.join(parent, "target");
    const linkedRoot = path.join(parent, "linked-root");
    await mkdir(target, { recursive: true, mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, linkedRoot);
    const symlinked = new PrivateRedemptionStateStore({
      platform: "darwin",
      rootPathForTests: linkedRoot,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 1, processStartIdentity: "owner" }),
    });
    await expect(symlinked.acquirePrepared(proposalInput)).rejects.toBeInstanceOf(CodexRedemptionPrivateStateError);
    expect((await stat(target)).mode & 0o777).toBe(0o755);

    const ancestorTarget = path.join(parent, "ancestor-target");
    const ancestorLink = path.join(parent, "ancestor-link");
    await mkdir(ancestorTarget, { mode: 0o755 });
    await symlink(ancestorTarget, ancestorLink);
    const symlinkedAncestor = new PrivateRedemptionStateStore({
      platform: "darwin",
      rootPathForTests: path.join(ancestorLink, "codex-reset-redemption"),
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 1, processStartIdentity: "owner" }),
    });
    await expect(symlinkedAncestor.acquirePrepared(proposalInput)).rejects.toMatchObject({
      code: "redemption-recovery-required",
    });
    await expect(lstat(path.join(ancestorTarget, "codex-reset-redemption"))).rejects.toMatchObject({ code: "ENOENT" });

    const anchorTarget = path.join(parent, "anchor-target");
    const anchorLink = path.join(parent, "anchor-link");
    await mkdir(anchorTarget, { mode: 0o755 });
    await symlink(anchorTarget, anchorLink);
    const symlinkedAnchor = new PrivateRedemptionStateStore({
      platform: "darwin",
      rootPathForTests: path.join(anchorLink, "state", "codex-reset-redemption"),
      rootAnchorForTests: anchorLink,
      currentOwner: async () => ({ pid: 1, processStartIdentity: "owner" }),
    });
    await expect(symlinkedAnchor.acquirePrepared(proposalInput)).rejects.toMatchObject({
      code: "redemption-recovery-required",
    });
    await expect(lstat(path.join(anchorTarget, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enables Windows only with verified private-path security", async () => {
    const parent = await makeTempRoot();
    const windowsRoot = path.join(parent, "windows-root");
    const windowsSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async () => {}),
    };
    const windows = new PrivateRedemptionStateStore({
      platform: "win32",
      rootPathForTests: windowsRoot,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 1, processStartIdentity: "owner" }),
      windowsSecurity,
    });
    const windowsJournal = await windows.acquirePrepared(proposalInput);
    await expect(windows.readPublicState(windowsJournal.proposalId)).resolves.toMatchObject({
      status: "prepared",
      proposalId: windowsJournal.proposalId,
    });
    expect(windowsSecurity.secureCreatedDirectory).toHaveBeenCalledWith(windowsRoot);
    expect(windowsSecurity.verifyPrivatePath).toHaveBeenCalledWith(windowsRoot, true);
    expect(windowsSecurity.verifyPrivatePath).toHaveBeenCalledWith(
      path.join(windowsRoot, "active-redemption.json"),
      false,
    );

    const unavailableRoot = path.join(parent, "windows-unavailable");
    const unavailable = new PrivateRedemptionStateStore({
      platform: "win32",
      rootPathForTests: unavailableRoot,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 1, processStartIdentity: "owner" }),
      windowsSecurity: {
        secureCreatedDirectory: async () => { throw new Error("icacls failed"); },
        verifyPrivatePath: async () => {},
      },
    });
    await expect(unavailable.acquirePrepared(proposalInput)).rejects.toMatchObject({
      code: "redemption-private-state-unavailable",
    });
  });

  it("keeps the dashboard readable when the Windows known-folder lookup is unavailable", async () => {
    const windowsLocalApplicationData = vi.fn(() => { throw new Error("PowerShell blocked"); });
    const store = new PrivateRedemptionStateStore({
      platform: "win32",
      homedir: () => "C:\\Users\\Operator Name",
      windowsLocalApplicationData,
    });

    await expect(store.readPublicState()).resolves.toMatchObject({
      status: "unavailable",
      code: "redemption-private-state-unavailable",
    });
    await expect(store.initializeRecovery()).resolves.toEqual({ status: "unavailable" });
    expect(windowsLocalApplicationData).toHaveBeenCalledTimes(2);
    await expect(store.acquirePrepared(proposalInput)).rejects.toMatchObject({
      code: "redemption-private-state-unavailable",
    });
  });

  it("revalidates ancestors before read after the configured state path is replaced", async () => {
    const { store, parent, rootPathForTests } = await storeHarness();
    const journal = await store.acquirePrepared(proposalInput);
    const stateDirectory = path.dirname(rootPathForTests);
    const movedDirectory = path.join(parent, "moved-state");
    const outsideDirectory = path.join(parent, "outside-state");
    await mkdir(outsideDirectory, { mode: 0o700 });
    await rename(stateDirectory, movedDirectory);
    await symlink(outsideDirectory, stateDirectory);

    await expect(store.readPublicState(journal.proposalId)).resolves.toMatchObject({
      status: "recovery-required",
      code: "redemption-recovery-required",
    });
  });

  it.skipIf(process.platform === "win32")("fails closed for broad journal permissions and unrelated hard links", async () => {
    const broad = await storeHarness();
    const broadJournal = await broad.store.acquirePrepared(proposalInput);
    await chmod(path.join(broad.rootPathForTests, "active-redemption.json"), 0o400);
    await expect(broad.store.readPublicState(broadJournal.proposalId)).resolves.toMatchObject({
      status: "recovery-required",
    });

    const rootMode = await storeHarness();
    await rootMode.store.acquirePrepared(proposalInput);
    await chmod(rootMode.rootPathForTests, 0o500);
    await expect(rootMode.store.readPublicState(proposalInput.proposalId)).resolves.toMatchObject({
      status: "recovery-required",
    });

    const linked = await storeHarness();
    await linked.store.acquirePrepared(proposalInput);
    await link(
      path.join(linked.rootPathForTests, "active-redemption.json"),
      path.join(linked.parent, "unrelated-hard-link.json"),
    );
    await expect(linked.store.acquirePrepared({
      ...proposalInput,
      proposalId: "q".repeat(43),
    })).rejects.toMatchObject({ code: "redemption-recovery-required" });
  });

  it("atomically transitions dispatch state and replays a terminal tombstone after lease release", async () => {
    const { store } = await storeHarness();
    const prepared = await store.acquirePrepared(proposalInput);
    const dispatchAt = "2026-07-16T12:00:01.000Z";
    await expect(store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
      ...prepared,
      phase: "terminal",
      dispatchAt,
      terminalAt: dispatchAt,
      outcome: "reset",
      reconciliation: "reconciled",
      auditEventId: "a".repeat(43),
    })).rejects.toMatchObject({ code: "redemption-recovery-required" });
    const dispatchIntent = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
      ...prepared,
      phase: "dispatch-intent",
      dispatchAt,
      updatedAt: dispatchAt,
    });
    const dispatched = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
      ...dispatchIntent,
      phase: "dispatched",
      updatedAt: "2026-07-16T12:00:02.000Z",
    });
    const terminalPending = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatched", {
      ...dispatched,
      phase: "terminal",
      terminalAt: "2026-07-16T12:00:03.000Z",
      outcome: "reset",
      reconciliation: "pending",
      auditEventId: "a".repeat(43),
      updatedAt: "2026-07-16T12:00:03.000Z",
    });
    const terminal = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "terminal", {
      ...terminalPending,
      reconciliation: "reconciled",
      updatedAt: "2026-07-16T12:00:04.000Z",
    });
    expect(terminal.phase).toBe("terminal");
    await expect(store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "terminal", {
      ...terminal,
      reconciliation: "pending",
      updatedAt: "2026-07-16T12:00:05.000Z",
    })).rejects.toMatchObject({ code: "redemption-recovery-required" });
    await expect(store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "terminal", {
      ...terminal,
      reconciliation: "unreconciled",
      updatedAt: "2026-07-16T12:00:05.000Z",
    })).rejects.toMatchObject({ code: "redemption-recovery-required" });
    const tombstone = {
      schemaVersion: 1 as const,
      proposalId: prepared.proposalId,
      selectionMode: "specific" as const,
      outcome: "reset" as const,
      reconciliation: "reconciled" as const,
      auditEventId: "a".repeat(43),
      message: "Usage limits reset. Checking current usage…",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    await store.publishTombstone(tombstone);
    await expect(store.publishTombstone({ ...tombstone, auditEventId: "b".repeat(43) })).rejects.toMatchObject({
      code: "redemption-recovery-required",
    });
    await store.releaseTerminal(prepared.proposalId, prepared.ownerNonce, "a".repeat(43));

    await expect(store.readPublicState(prepared.proposalId)).resolves.toEqual({ status: "terminal", tombstone });
  });

  it("fails closed when terminal tombstone conflicts with the active terminal journal", async () => {
    const { store, rootPathForTests } = await storeHarness();
    const prepared = await store.acquirePrepared(proposalInput);
    const dispatchIntent = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
      ...prepared,
      phase: "dispatch-intent",
      dispatchAt: "2026-07-16T12:00:01.000Z",
      updatedAt: "2026-07-16T12:00:01.000Z",
    });
    const dispatched = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
      ...dispatchIntent,
      phase: "dispatched",
      updatedAt: "2026-07-16T12:00:02.000Z",
    });
    const terminal = await store.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatched", {
      ...dispatched,
      phase: "terminal",
      terminalAt: "2026-07-16T12:00:03.000Z",
      outcome: "reset",
      reconciliation: "reconciled",
      auditEventId: "a".repeat(43),
      updatedAt: "2026-07-16T12:00:03.000Z",
    });
    const tombstone = {
      schemaVersion: 1 as const,
      proposalId: terminal.proposalId,
      selectionMode: terminal.selection.mode,
      outcome: terminal.outcome!,
      reconciliation: terminal.reconciliation as "reconciled",
      auditEventId: terminal.auditEventId!,
      message: "Usage limits reset. Checking current usage…",
      createdAt: "2026-07-16T12:00:03.000Z",
      expiresAt: "2026-07-16T12:10:03.000Z",
    };
    await store.publishTombstone(tombstone);
    await writeFile(
      path.join(rootPathForTests, `terminal-redemption-${prepared.proposalId}.json`),
      `${JSON.stringify({ ...tombstone, outcome: "noCredit" })}\n`,
      { mode: 0o600 },
    );

    await expect(store.readPublicState(prepared.proposalId)).resolves.toMatchObject({
      status: "recovery-required",
    });
  });

  it("verifies retained account and runtime evidence without regenerating a missing digest key", async () => {
    const { store, rootPathForTests } = await storeHarness();
    const journal = await store.acquirePrepared(proposalInput);

    await expect(store.verifyRecoveryEvidence(journal, {
      accountCheck: proposalInput.accountCheck,
      runtimeIdentity: proposalInput.runtimeIdentity,
    })).resolves.toEqual({ accountMatches: true, runtimeMatches: true });
    await expect(store.verifyRecoveryEvidence(journal, {
      accountCheck: { ...proposalInput.accountCheck, email: "other@example.com" },
      runtimeIdentity: proposalInput.runtimeIdentity,
    })).resolves.toEqual({ accountMatches: false, runtimeMatches: true });
    await expect(store.verifyRecoveryEvidence(journal, {
      accountCheck: proposalInput.accountCheck,
      runtimeIdentity: { ...proposalInput.runtimeIdentity, canonicalPath: "/other/codex" },
    })).resolves.toEqual({ accountMatches: true, runtimeMatches: false });
    await expect(store.verifyRecoveryEvidence(journal, {
      accountCheck: proposalInput.accountCheck,
      runtimeIdentity: { ...proposalInput.runtimeIdentity, codexStateRoot: "/other/codex-home" },
    })).resolves.toEqual({ accountMatches: true, runtimeMatches: false });

    await unlink(path.join(rootPathForTests, "account-digest.key"));
    await expect(store.verifyRecoveryEvidence(journal, {
      accountCheck: proposalInput.accountCheck,
      runtimeIdentity: proposalInput.runtimeIdentity,
    })).rejects.toMatchObject({ code: "redemption-recovery-required" });
    await expect(stat(path.join(rootPathForTests, "account-digest.key"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
