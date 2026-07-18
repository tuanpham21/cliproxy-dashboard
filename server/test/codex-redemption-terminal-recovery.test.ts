import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { CodexRateLimitsRead } from "../codex-account-gateway.js";
import { PrivateRedemptionStateStore } from "../codex-redemption-private-state.js";
import { CodexRedemptionService } from "../codex-redemption-service.js";
import type { TerminalRedemptionTombstone } from "../codex-redemption-journal.js";
import { makeTempRoot } from "./helpers.js";
import { privateStatePlatformDependencies } from "./private-state-platform.js";

const runtimeIdentity = {
    canonicalPath: "/opt/codex/bin/codex",
    codexStateRoot: "/home/operator/.codex",
    codexSqliteRoot: "/home/operator/.codex/sqlite",
  version: "codex-cli 0.144.4",
  fileIdentity: "1:2:3:4:5",
  schemaHash: "a".repeat(64),
};

const rateLimits: CodexRateLimitsRead = {
  rateLimits: {
    limitId: null,
    limitName: null,
    primary: { usedPercent: 0, windowMinutes: 300, resetsAt: 1_800_000_000 },
    secondary: null,
    plan: "pro",
  },
  rateLimitsByLimitId: null,
  resetCredits: { availableCount: 0, credits: [] },
};

async function terminalRecoveryHarness(reconciliation: "pending" | "reconciled") {
  const parent = await makeTempRoot();
  const rootPathForTests = path.join(parent, "state with spaces", "codex-reset-redemption");
  const dependencies = {
    ...privateStatePlatformDependencies(),
    rootPathForTests,
    rootAnchorForTests: parent,
    currentOwner: async () => ({ pid: 1000, processStartIdentity: "boot-a:start-1000" }),
    inspectOwner: async () => "dead" as const,
    now: () => Date.parse("2026-07-16T12:04:00.000Z"),
  };
  const originalStore = new PrivateRedemptionStateStore(dependencies);
  const store = new PrivateRedemptionStateStore({
    ...dependencies,
    currentOwner: async () => ({ pid: 2000, processStartIdentity: "boot-a:start-2000" }),
  });
  const prepared = await originalStore.acquirePrepared({
    proposalId: "p".repeat(43),
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
    accountCheck: { email: "operator@example.com", plan: "pro" },
    selection: { mode: "generic" },
    runtimeIdentity,
    createdAt: "2026-07-16T12:00:00.000Z",
    expiresAt: "2026-07-16T12:02:00.000Z",
  });
  const intent = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "prepared", {
    ...prepared,
    phase: "dispatch-intent",
    dispatchAt: "2026-07-16T12:00:01.000Z",
    updatedAt: "2026-07-16T12:00:01.000Z",
  });
  const dispatched = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatch-intent", {
    ...intent,
    phase: "dispatched",
    updatedAt: "2026-07-16T12:00:02.000Z",
  });
  const terminal = await originalStore.transitionJournal(prepared.proposalId, prepared.ownerNonce, "dispatched", {
    ...dispatched,
    phase: "terminal",
    terminalAt: "2026-07-16T12:00:03.000Z",
    outcome: "reset",
    reconciliation,
    auditEventId: "a".repeat(43),
    updatedAt: "2026-07-16T12:00:03.000Z",
  });
  const gateway = {
    readAccount: vi.fn(async () => ({
      account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
      providerRequiresOpenAiAuth: true,
    })),
    readRateLimits: vi.fn(async () => rateLimits),
    consumeResetCredit: vi.fn(),
    };
    const startSession = vi.fn(async () => ({ close: vi.fn(async () => {}) }));
    const auditSink = vi.fn(async () => {});
    const qualifier = {
      qualify: vi.fn(async () => ({ status: "qualified" as const, version: runtimeIdentity.version, identity: runtimeIdentity })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    const service = new CodexRedemptionService({
      qualifier,
    store,
    startSession,
    gatewayForSession: () => gateway,
    now: () => new Date("2026-07-16T12:04:00.000Z"),
    auditSink,
  });
    return { service, store, originalStore, terminal, gateway, startSession, auditSink, qualifier, parent, rootPathForTests };
}

function matchingTombstone(terminal: Awaited<ReturnType<typeof terminalRecoveryHarness>>["terminal"]): TerminalRedemptionTombstone {
  return {
    schemaVersion: 1,
    proposalId: terminal.proposalId,
    selectionMode: terminal.selection.mode,
    outcome: "reset",
    reconciliation: "reconciled",
    auditEventId: "a".repeat(43),
    message: "Usage limits reset. Checking current usage…",
    createdAt: "2026-07-16T12:00:03.000Z",
    expiresAt: "2026-07-16T12:10:03.000Z",
  };
}

describe("terminal reset-redemption startup recovery", () => {
    it("finishes pending read-only reconciliation and cleanup without another consume", async () => {
      const harness = await terminalRecoveryHarness("pending");
      const sentinelPath = path.join(harness.parent, "proxy-routing-and-credentials.bin");
      const sentinel = Buffer.from("proxy state remains untouched\n");
      await writeFile(sentinelPath, sentinel);

      await harness.service.initializeRecovery("codex");

    expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();
    expect(harness.gateway.readRateLimits).toHaveBeenCalledTimes(1);
    expect(harness.auditSink).toHaveBeenCalledWith(expect.objectContaining({ eventId: "a".repeat(43) }));
      await expect(harness.store.readPublicState(harness.terminal.proposalId)).resolves.toMatchObject({
        status: "terminal",
        tombstone: { outcome: "reset", reconciliation: "reconciled" },
      });
      await expect(readFile(sentinelPath)).resolves.toEqual(sentinel);
    });

  it("uses a matching tombstone to finish audit and lease cleanup without Codex activity", async () => {
    const harness = await terminalRecoveryHarness("reconciled");
    await harness.originalStore.publishTombstone(matchingTombstone(harness.terminal));

    await harness.service.initializeRecovery("codex");

    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();
    expect(harness.auditSink).toHaveBeenCalledTimes(1);
    await expect(harness.store.readPublicState(harness.terminal.proposalId)).resolves.toMatchObject({ status: "terminal" });
    await expect(harness.service.currentState()).resolves.toMatchObject({
      status: "terminal",
      proposalId: harness.terminal.proposalId,
    });
  });

  it("uses expired matching tombstone as recovery evidence, then stops public replay", async () => {
    const harness = await terminalRecoveryHarness("reconciled");
    const tombstone = {
      ...matchingTombstone(harness.terminal),
      expiresAt: "2026-07-16T12:03:59.000Z",
    };
    await harness.originalStore.publishTombstone(tombstone);

    await harness.service.initializeRecovery("codex");

      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.auditSink).toHaveBeenCalledTimes(1);
      await expect(harness.store.readPublicState(harness.terminal.proposalId)).resolves.toEqual({ status: "not-found" });
      await expect(stat(
        path.join(harness.rootPathForTests, `terminal-redemption-${harness.terminal.proposalId}.json`),
      )).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("hard-blocks a conflicting tombstone without Codex, audit, or cleanup", async () => {
    const harness = await terminalRecoveryHarness("reconciled");
    const tombstone = matchingTombstone(harness.terminal);
    await harness.originalStore.publishTombstone(tombstone);
    await writeFile(
      path.join(harness.rootPathForTests, `terminal-redemption-${harness.terminal.proposalId}.json`),
      `${JSON.stringify({ ...tombstone, outcome: "noCredit" })}\n`,
      { mode: 0o600 },
    );

    await harness.service.initializeRecovery("codex");

      expect(harness.startSession).not.toHaveBeenCalled();
      expect(harness.auditSink).not.toHaveBeenCalled();
      await expect(harness.store.readPublicState(harness.terminal.proposalId)).resolves.toMatchObject({ status: "recovery-required" });
      harness.qualifier.qualify.mockClear();
      await expect(harness.service.prepare("codex", { singleWorkspaceAttested: true })).rejects.toMatchObject({
        code: "redemption-recovery-required",
      });
      expect(harness.qualifier.qualify).not.toHaveBeenCalled();
    });

    it("exposes recovery-required until failed terminal cleanup succeeds", async () => {
      const harness = await terminalRecoveryHarness("reconciled");
      await harness.originalStore.publishTombstone(matchingTombstone(harness.terminal));
      harness.auditSink.mockRejectedValueOnce(new Error("audit unavailable"));

      await harness.service.initializeRecovery("codex");

      await expect(harness.service.currentState()).resolves.toMatchObject({ status: "recovery-required" });
      expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();

      await harness.service.initializeRecovery("codex");
      await expect(harness.service.currentState()).resolves.toMatchObject({
        status: "terminal",
        proposalId: harness.terminal.proposalId,
      });
      expect(harness.auditSink).toHaveBeenCalledTimes(2);
    });
  });
