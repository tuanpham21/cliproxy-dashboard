import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexAccountGatewayError, type CodexRateLimitsRead } from "../codex-account-gateway.js";
import { PrivateRedemptionStateStore } from "../codex-redemption-private-state.js";
import { CodexRedemptionService, type CodexRedemptionSessionOptions } from "../codex-redemption-service.js";
import type { CodexRuntimeQualification } from "../codex-runtime-qualifier.js";
import { makeTempRoot } from "./helpers.js";
import { privateStatePlatformDependencies } from "./private-state-platform.js";

const qualified: CodexRuntimeQualification = {
  status: "qualified",
  version: "codex-cli 0.144.4",
  identity: {
      canonicalPath: "/opt/codex/bin/codex",
      codexStateRoot: "/home/operator/.codex",
      codexSqliteRoot: "/home/operator/.codex/sqlite",
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4:5",
    schemaHash: "a".repeat(64),
  },
};

const reconciledRateLimits: CodexRateLimitsRead = {
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

async function recoveryServiceHarness(selection: { mode: "specific"; creditId: string } | { mode: "generic" }) {
  const parent = await makeTempRoot();
  const rootPathForTests = path.join(parent, "state with spaces", "codex-reset-redemption");
  const common = {
    ...privateStatePlatformDependencies(),
    rootPathForTests,
    rootAnchorForTests: parent,
    now: () => Date.parse("2026-07-16T12:03:00.000Z"),
    inspectOwner: async (owner: { pid: number }) => owner.pid === 1000 ? "dead" as const : "alive" as const,
  };
  const originalStore = new PrivateRedemptionStateStore({
    ...common,
    currentOwner: async () => ({ pid: 1000, processStartIdentity: "boot-a:start-1000" }),
  });
  const store = new PrivateRedemptionStateStore({
    ...common,
    currentOwner: async () => ({ pid: 2000, processStartIdentity: "boot-a:start-2000" }),
  });
  const prepared = await originalStore.acquirePrepared({
    proposalId: "p".repeat(43),
    idempotencyKey: "11111111-2222-4333-8444-555555555555",
    accountCheck: { email: "operator@example.com", plan: "pro" },
    selection,
    runtimeIdentity: qualified.identity,
    createdAt: "2026-07-16T12:00:00.000Z",
    expiresAt: "2026-07-16T12:02:00.000Z",
  });
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
  const events: string[] = [];
  const gateway = {
    readAccount: vi.fn(async () => {
      events.push("account");
      return {
        account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
        providerRequiresOpenAiAuth: true,
      };
    }),
    readRateLimits: vi.fn(async () => {
      events.push("rate-limits");
      return reconciledRateLimits;
    }),
    consumeResetCredit: vi.fn(async (input: {
      idempotencyKey: string;
      creditId?: string;
      beforeWrite?: () => Promise<void> | void;
      afterWrite?: () => Promise<void> | void;
    }) => {
      events.push("consume");
      await input.beforeWrite?.();
      await input.afterWrite?.();
      return { outcome: "alreadyRedeemed" as const };
    }),
  };
  const session = { close: vi.fn(async () => events.push("close")) };
  const qualifier = {
    qualify: vi.fn(async () => qualified),
    matchesIdentity: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
    let sessionOptions: CodexRedemptionSessionOptions | null = null;
    const startSession = vi.fn(async (options: CodexRedemptionSessionOptions) => {
      sessionOptions = options;
      return session;
    });
  const service = new CodexRedemptionService({
    qualifier,
    store,
    startSession,
    gatewayForSession: () => gateway,
    now: () => new Date("2026-07-16T12:03:00.000Z"),
    auditSink: vi.fn(async () => events.push("audit")),
  });
    return {
      service,
      store,
      prepared,
      gateway,
      session,
      events,
      qualifier,
      startSession,
      sessionOptions: () => sessionOptions,
      parent,
      rootPathForTests,
    };
}

describe("ambiguous reset-redemption recovery", () => {
  it.each([
    [{ mode: "specific", creditId: "credit-secret-id" } as const, "credit-secret-id"],
    [{ mode: "generic" } as const, undefined],
  ])("retries lost %s redemption with exact retained key and selection", async (selection, expectedCreditId) => {
    const harness = await recoveryServiceHarness(selection);
    await harness.service.initializeRecovery("codex");

    await expect(harness.service.consume(harness.prepared.proposalId, "codex")).resolves.toMatchObject({
      status: "terminal",
      outcome: "alreadyRedeemed",
      reconciliation: "reconciled",
      accountUsage: { resetCredits: { availableCount: 0 } },
    });
    expect(harness.gateway.consumeResetCredit).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "11111111-2222-4333-8444-555555555555",
      ...(expectedCreditId ? { creditId: expectedCreditId } : {}),
    }));
      if (!expectedCreditId) expect(harness.gateway.consumeResetCredit.mock.calls[0][0]).not.toHaveProperty("creditId");
      expect(harness.events.slice(0, 3)).toEqual(["account", "consume", "rate-limits"]);
      expect(harness.sessionOptions()).toMatchObject({
        runtimeContext: {
          codexStateRoot: qualified.identity.codexStateRoot,
          codexSqliteRoot: qualified.identity.codexSqliteRoot,
        },
      });
      expect(harness.gateway.readRateLimits).toHaveBeenCalledTimes(1);
  });

  it("retains ambiguous state and performs zero consume on account-digest mismatch", async () => {
    const harness = await recoveryServiceHarness({ mode: "generic" });
    harness.gateway.readAccount.mockResolvedValue({
      account: { type: "chatgpt", email: "other@example.com", plan: "pro" },
      providerRequiresOpenAiAuth: false,
    });
    await harness.service.initializeRecovery("codex");

    await expect(harness.service.consume(harness.prepared.proposalId, "codex")).rejects.toMatchObject({
      code: "codex_recovery_account_mismatch",
    });
    expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();
    await expect(harness.store.readPublicState(harness.prepared.proposalId)).resolves.toMatchObject({ status: "ambiguous" });
  });

  it("retains ambiguous state and performs zero consume on retained runtime mismatch", async () => {
    const harness = await recoveryServiceHarness({ mode: "generic" });
    harness.qualifier.qualify.mockResolvedValue({
      status: "qualified",
      version: "codex-cli 0.144.4",
      identity: { ...qualified.identity, canonicalPath: "/other/codex" },
    });
      await harness.service.initializeRecovery("codex");

      await expect(harness.service.consume(harness.prepared.proposalId, "codex")).rejects.toMatchObject({
        code: "codex_recovery_session_changed",
        message: "Codex recovery session changed. This redemption outcome remains unconfirmed. Restore the original qualified runtime and account, then retry. New redemptions remain blocked.",
      });
      expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();
      await expect(harness.store.readPublicState(harness.prepared.proposalId)).resolves.toMatchObject({ status: "ambiguous" });
    });

    it("blocks provider write when recovery session invalidates during runtime revalidation", async () => {
      const harness = await recoveryServiceHarness({ mode: "generic" });
      let providerWrites = 0;
      harness.qualifier.matchesIdentity
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(async () => {
          await harness.sessionOptions()?.onNotification({ method: "account/updated" });
          return true;
        });
      harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
        try {
          await input.beforeWrite?.();
        } catch (error) {
          throw new CodexAccountGatewayError(
            "transport-failed",
            "not-written",
            error instanceof Error && "code" in error ? String(error.code) : undefined,
          );
        }
        providerWrites += 1;
        return { outcome: "alreadyRedeemed" as const };
      });
      await harness.service.initializeRecovery("codex");

      await expect(harness.service.consume(harness.prepared.proposalId, "codex")).rejects.toMatchObject({
        code: "codex_recovery_session_changed",
      });
      expect(providerWrites).toBe(0);
      await expect(harness.store.readPublicState(harness.prepared.proposalId)).resolves.toMatchObject({ status: "ambiguous" });
    });

  it("keeps current-state discovery and proposal polling free of Codex or provider activity", async () => {
    const harness = await recoveryServiceHarness({ mode: "generic" });
    await harness.service.initializeRecovery("codex");
    harness.qualifier.qualify.mockClear();
    harness.qualifier.matchesIdentity.mockClear();
    harness.startSession.mockClear();

    await expect(harness.service.currentState()).resolves.toMatchObject({ status: "ambiguous" });
    await expect(harness.service.state(harness.prepared.proposalId)).resolves.toMatchObject({ status: "ambiguous" });
    await expect(harness.service.state(harness.prepared.proposalId)).resolves.toMatchObject({ status: "ambiguous" });

    expect(harness.qualifier.qualify).not.toHaveBeenCalled();
    expect(harness.qualifier.matchesIdentity).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.gateway.readAccount).not.toHaveBeenCalled();
    expect(harness.gateway.readRateLimits).not.toHaveBeenCalled();
    expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();
  });

    it("allows one provider call across simultaneous dashboard retry attempts", async () => {
    const harness = await recoveryServiceHarness({ mode: "generic" });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
      harness.events.push("consume");
      await input.beforeWrite?.();
      await input.afterWrite?.();
      await providerGate;
      return { outcome: "alreadyRedeemed" as const };
    });
    const secondStore = new PrivateRedemptionStateStore({
      ...privateStatePlatformDependencies(),
      rootPathForTests: harness.rootPathForTests,
      rootAnchorForTests: harness.parent,
      currentOwner: async () => ({ pid: 3000, processStartIdentity: "boot-a:start-3000" }),
      inspectOwner: async (owner) => owner.pid === 1000 ? "dead" : "alive",
      now: () => Date.parse("2026-07-16T12:03:00.000Z"),
    });
    const second = new CodexRedemptionService({
      qualifier: harness.qualifier,
      store: secondStore,
      startSession: vi.fn(async () => ({ close: vi.fn(async () => {}) })),
      gatewayForSession: () => harness.gateway,
      now: () => new Date("2026-07-16T12:03:00.000Z"),
      auditSink: vi.fn(async () => {}),
    });
    await Promise.all([
      harness.service.initializeRecovery("codex"),
      second.initializeRecovery("codex"),
    ]);

    const firstRetry = harness.service.consume(harness.prepared.proposalId, "codex");
    await vi.waitFor(() => expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1));
    await expect(second.consume(harness.prepared.proposalId, "codex")).resolves.toMatchObject({
      status: "processing",
      phase: "retrying",
      allowedAction: "poll",
    });
    expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
      releaseProvider();
      await expect(firstRetry).resolves.toMatchObject({ status: "terminal", outcome: "alreadyRedeemed" });
    });

    it.each(["success", "account-mismatch", "ambiguous-transport"] as const)(
      "leaves Proxy Account and routing evidence byte-identical after %s recovery",
      async (scenario) => {
        const harness = await recoveryServiceHarness({ mode: "generic" });
        const sentinels = new Map([
          [path.join(harness.parent, "proxy-quota-snapshot.json"), Buffer.from('{"used":42}\n')],
          [path.join(harness.parent, "rotation-state.json"), Buffer.from('{"target":"proxy-a"}\n')],
          [path.join(harness.parent, "routing-priorities.yaml"), Buffer.from("proxy-a: 10\n")],
          [path.join(harness.parent, "proxy-credentials.json"), Buffer.from('{"secret":"unchanged"}\n')],
        ]);
        await Promise.all([...sentinels].map(async ([filePath, content]) => await writeFile(filePath, content)));
        if (scenario === "account-mismatch") {
          harness.gateway.readAccount.mockResolvedValue({
            account: { type: "chatgpt", email: "other@example.com", plan: "pro" },
            providerRequiresOpenAiAuth: false,
          });
        } else if (scenario === "ambiguous-transport") {
          harness.gateway.consumeResetCredit.mockRejectedValue(
            new CodexAccountGatewayError("transport-failed", "possibly-written"),
          );
        }
        await harness.service.initializeRecovery("codex");

        if (scenario === "account-mismatch") {
          await expect(harness.service.consume(harness.prepared.proposalId, "codex")).rejects.toMatchObject({
            code: "codex_recovery_account_mismatch",
          });
        } else {
          await expect(harness.service.consume(harness.prepared.proposalId, "codex")).resolves.toMatchObject({
            status: scenario === "success" ? "terminal" : "ambiguous",
          });
        }
        for (const [filePath, expected] of sentinels) {
          await expect(readFile(filePath)).resolves.toEqual(expected);
        }
      },
    );
  });

describe("prepared reset-redemption restart recovery", () => {
    it("keeps checking an expired recovered proposal until its owner dies", async () => {
    const parent = await makeTempRoot();
      const rootPathForTests = path.join(parent, "state with spaces", "codex-reset-redemption");
      let nowMs = Date.parse("2026-07-16T12:01:00.000Z");
      let ownerAlive = true;
    const originalStore = new PrivateRedemptionStateStore({
      ...privateStatePlatformDependencies(),
      rootPathForTests,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 1000, processStartIdentity: "boot-a:start-1000" }),
      inspectOwner: async () => "alive",
      now: () => nowMs,
    });
    const restartedStore = new PrivateRedemptionStateStore({
      ...privateStatePlatformDependencies(),
      rootPathForTests,
      rootAnchorForTests: parent,
      currentOwner: async () => ({ pid: 2000, processStartIdentity: "boot-a:start-2000" }),
        inspectOwner: async (owner) => owner.pid === 1000 && ownerAlive ? "alive" : "dead",
      now: () => nowMs,
    });
    await originalStore.acquirePrepared({
      proposalId: "p".repeat(43),
      idempotencyKey: "11111111-2222-4333-8444-555555555555",
      accountCheck: { email: "operator@example.com", plan: "pro" },
      selection: { mode: "generic" },
      runtimeIdentity: qualified.identity,
      createdAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
    });
      const scheduledRecoveries: Array<{ callback: () => void; delayMs: number }> = [];
    const service = new CodexRedemptionService({
      qualifier: {
        qualify: vi.fn(async () => qualified),
        matchesIdentity: vi.fn(async () => true),
        close: vi.fn(async () => {}),
      },
      store: restartedStore,
        now: () => new Date(nowMs),
        schedule: (callback, delayMs) => {
          scheduledRecoveries.push({ callback, delayMs });
          return scheduledRecoveries.length as unknown as NodeJS.Timeout;
      },
      clearScheduled: vi.fn(),
    });

      await Promise.all([
        service.initializeRecovery("codex"),
        service.initializeRecovery("codex"),
      ]);
      await expect(service.currentState()).resolves.toMatchObject({ status: "prepared", allowedAction: "poll" });
      expect(scheduledRecoveries).toMatchObject([{ delayMs: 60_000 }]);

      nowMs = Date.parse("2026-07-16T12:03:00.000Z");
      scheduledRecoveries[0].callback();
      await vi.waitFor(() => expect(scheduledRecoveries).toHaveLength(2));
      expect(scheduledRecoveries[1].delayMs).toBe(5_000);
      await expect(service.currentState()).resolves.toMatchObject({ status: "prepared" });

      ownerAlive = false;
      scheduledRecoveries[1].callback();
      await vi.waitFor(async () => {
        await expect(service.currentState()).resolves.toEqual({ status: "not-found" });
      });
    });

    it("preserves unavailable Windows private state through startup and mutation blocking", async () => {
      const store = new PrivateRedemptionStateStore({
        platform: "win32",
        homedir: () => "C:\\Users\\Operator Name",
        windowsLocalApplicationData: () => { throw new Error("PowerShell blocked"); },
      });
      const service = new CodexRedemptionService({
        qualifier: {
          qualify: vi.fn(async () => qualified),
          matchesIdentity: vi.fn(async () => true),
          close: vi.fn(async () => {}),
        },
        store,
        schedule: vi.fn(() => 1 as unknown as NodeJS.Timeout),
        clearScheduled: vi.fn(),
      });

      await service.initializeRecovery("codex");

      await expect(service.currentState()).resolves.toEqual({
        status: "unavailable",
        code: "redemption-private-state-unavailable",
        message: "Private reset redemption state is unavailable on this host.",
      });
      await expect(service.prepare("codex", {
        singleWorkspaceAttested: true,
        selection: { mode: "generic" },
      })).rejects.toMatchObject({ code: "redemption-private-state-unavailable" });
      await service.close();
    });

    it("rechecks unavailable private state after five seconds and clears the block", async () => {
      const parent = await makeTempRoot();
      const store = new PrivateRedemptionStateStore({
        ...privateStatePlatformDependencies(),
        rootPathForTests: path.join(parent, "recheck-state"),
        rootAnchorForTests: parent,
      });
      let available = false;
      vi.spyOn(store, "initializeRecovery").mockImplementation(async () => (
        available ? { status: "idle" } : { status: "unavailable" }
      ));
      vi.spyOn(store, "readPublicState").mockImplementation(async () => (
        available
          ? { status: "not-found" }
          : {
              status: "unavailable",
              code: "redemption-private-state-unavailable",
              message: "Private reset redemption state is unavailable on this host.",
            }
      ));
      const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
      const service = new CodexRedemptionService({
        qualifier: {
          qualify: vi.fn(async () => qualified),
          matchesIdentity: vi.fn(async () => true),
          close: vi.fn(async () => {}),
        },
        store,
        schedule: (callback, delayMs) => {
          scheduled.push({ callback, delayMs });
          return scheduled.length as unknown as NodeJS.Timeout;
        },
        clearScheduled: vi.fn(),
      });

      await service.initializeRecovery("codex");
      expect(scheduled).toMatchObject([{ delayMs: 5_000 }]);
      await expect(service.currentState()).resolves.toMatchObject({ status: "unavailable" });

      available = true;
      scheduled[0].callback();
      await vi.waitFor(async () => {
        await expect(service.currentState()).resolves.toEqual({ status: "not-found" });
      });
      await service.close();
    });
  });
