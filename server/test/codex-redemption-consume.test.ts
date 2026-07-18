import { describe, expect, it, vi } from "vitest";

import {
  CodexAccountGatewayError,
  type CodexRateLimitsRead,
} from "../codex-account-gateway.js";
import type { PublicPrivateRedemptionState } from "../codex-redemption-private-state.js";
import { CodexRedemptionService } from "../codex-redemption-service.js";
import type { CodexRuntimeQualification } from "../codex-runtime-qualifier.js";

const qualified: CodexRuntimeQualification = {
  status: "qualified",
  version: "codex-cli 0.144.4",
  identity: {
    canonicalPath: "/opt/codex/bin/codex",
    codexStateRoot: "/home/operator/.codex",
    codexSqliteRoot: "/home/operator/.codex/sqlite",
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4",
    schemaHash: "a".repeat(64),
  },
};

const rateLimits: CodexRateLimitsRead = {
  rateLimits: {
    limitId: null,
    limitName: null,
    primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_800_000_000 },
    secondary: null,
    plan: "pro",
  },
  rateLimitsByLimitId: null,
  resetCredits: {
    availableCount: 1,
    credits: [{
      id: "credit-1",
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: 1_700_000_000,
      expiresAt: null,
      title: "Early reset",
      description: null,
      availability: "available",
    }],
  },
};

function consumeHarness() {
  const events: string[] = [];
  let publicState: PublicPrivateRedemptionState = { status: "not-found" };
  let activeJournal: any = null;
  let tombstone: Extract<PublicPrivateRedemptionState, { status: "terminal" }>["tombstone"] | null = null;
  const session = { close: vi.fn(async () => events.push("session-close")) };
  const gateway = {
    readAccount: vi.fn(async () => ({
      account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
      providerRequiresOpenAiAuth: true,
    })),
    readRateLimits: vi.fn(async () => rateLimits),
    consumeResetCredit: vi.fn(async (input: {
      beforeWrite?: () => Promise<void> | void;
      afterWrite?: () => Promise<void> | void;
    }) => {
      try {
        await input.beforeWrite?.();
      } catch (error) {
        throw new CodexAccountGatewayError(
          "transport-failed",
          "not-written",
          typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined,
        );
      }
      events.push("provider-write");
      await input.afterWrite?.();
      return { outcome: "reset" as const };
    }),
  };
  const store = {
    acquirePrepared: vi.fn(async (input: any) => {
      const journal = {
        schemaVersion: 1 as const,
        phase: "prepared" as const,
        proposalId: input.proposalId,
        ownerNonce: "n".repeat(43),
        owner: { pid: 1, processStartIdentity: "owner" },
        accountCheckDigest: "d".repeat(43),
        idempotencyKey: input.idempotencyKey,
        selection: input.selection,
        runtimeIdentity: {
          canonicalPathDigest: "r".repeat(43),
          version: input.runtimeIdentity.version,
          fileIdentity: input.runtimeIdentity.fileIdentity,
          schemaHash: input.runtimeIdentity.schemaHash,
        },
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
        updatedAt: input.createdAt,
      };
      publicState = {
        status: "prepared",
        proposalId: input.proposalId,
        selectionMode: input.selection.mode,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      };
      activeJournal = journal;
      return journal;
    }),
    transitionJournal: vi.fn(async (_proposalId: string, _ownerNonce: string, _expectedPhase: string, next: any) => {
      events.push(`journal:${next.phase}:${next.reconciliation ?? ""}`);
      if (next.phase === "prepared") {
        publicState = {
          status: "prepared",
          proposalId: next.proposalId,
          selectionMode: next.selection.mode,
          createdAt: next.createdAt,
          expiresAt: next.expiresAt,
        };
      } else if (next.phase === "ambiguous") {
        publicState = {
          status: "ambiguous",
          proposalId: next.proposalId,
          selectionMode: next.selection.mode,
          dispatchAt: next.dispatchAt,
        };
      } else {
        publicState = {
          status: "processing",
          proposalId: next.proposalId,
          selectionMode: next.selection.mode,
          phase: next.phase,
          dispatchAt: next.dispatchAt,
        };
      }
      activeJournal = next;
      return next;
    }),
    publishTombstone: vi.fn(async (next: any) => {
      events.push("tombstone");
      tombstone = next;
      publicState = { status: "terminal", tombstone: next };
    }),
    releasePrepared: vi.fn(async () => {
      events.push("prepared-release");
      activeJournal = null;
      publicState = tombstone ? { status: "terminal", tombstone } : { status: "not-found" };
    }),
    releaseTerminal: vi.fn(async () => {
      events.push("lease-release");
      activeJournal = null;
      publicState = tombstone ? { status: "terminal", tombstone } : { status: "not-found" };
    }),
    readJournal: vi.fn(async () => activeJournal),
    readPublicState: vi.fn(async () => publicState),
  };
  const auditSink = vi.fn(async () => events.push("audit"));
  let sessionOptions: any;
  const startSession = vi.fn(async (options) => {
    sessionOptions = options;
    return session;
  });
  const qualifier = {
    qualify: vi.fn(async () => qualified),
    matchesIdentity: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  const service = new CodexRedemptionService({
    qualifier,
    startSession,
    gatewayForSession: () => gateway,
    store,
    now: () => new Date("2026-07-16T12:00:00.000Z"),
    newProposalId: () => "p".repeat(43),
    newIdempotencyKey: () => "11111111-2222-4333-8444-555555555555",
    schedule: vi.fn(() => ({}) as NodeJS.Timeout),
    clearScheduled: vi.fn(),
    auditSink,
  });
  return { service, gateway, store, session, auditSink, events, qualifier, getSessionOptions: () => sessionOptions };
}

async function prepare(harness: ReturnType<typeof consumeHarness>) {
  return await harness.service.prepare("codex", {
    creditId: "credit-1",
    singleWorkspaceAttested: true,
  });
}

describe("Codex reset redemption consume", () => {
  it.each([
    ["reset", "Usage limits reset. Checking current usage…", "reconciled", 3],
    ["alreadyRedeemed", "This redemption was already completed. Checking current usage…", "reconciled", 3],
    ["nothingToReset", "No eligible usage limit needs a reset right now. No reset was applied.", "not-required", 2],
    ["noCredit", "That reset is no longer available. Refreshing account usage…", "reconciled", 3],
  ] as const)("maps terminal outcome %s with exact copy", async (outcome, message, reconciliation, readCount) => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
      await input.beforeWrite?.();
      await input.afterWrite?.();
      return { outcome };
    });

    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({
      status: "terminal",
      outcome,
      reconciliation,
      message,
    });
    expect(harness.gateway.readRateLimits).toHaveBeenCalledTimes(readCount);
  });

  it("uses exact generic no-credit copy without sending creditId", async () => {
    const harness = consumeHarness();
    harness.gateway.readRateLimits.mockResolvedValue({
      ...rateLimits,
      resetCredits: { availableCount: 1, credits: null },
    });
    const proposal = await harness.service.prepare("codex", { singleWorkspaceAttested: true });
    harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
      await input.beforeWrite?.();
      await input.afterWrite?.();
      expect(input).not.toHaveProperty("creditId", expect.any(String));
      return { outcome: "noCredit" as const };
    });

    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({
      outcome: "noCredit",
      message: "No usage limit resets are available. Refreshing account usage…",
    });
  });

  it("runs final checks, durable phases, reconciliation, tombstone, audit, and lease release in order", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);

    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({
      status: "terminal",
      outcome: "reset",
      reconciliation: "reconciled",
      message: "Usage limits reset. Checking current usage…",
    });
    expect(harness.gateway.readAccount).toHaveBeenCalledTimes(2);
    expect(harness.gateway.readRateLimits).toHaveBeenCalledTimes(3);
    expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
    expect(harness.events).toEqual([
      "journal:dispatch-intent:",
      "provider-write",
      "journal:dispatched:",
      "journal:terminal:pending",
      "journal:terminal:reconciled",
      "tombstone",
      "audit",
      "lease-release",
      "session-close",
    ]);
    expect(JSON.stringify(harness.auditSink.mock.calls[0][0])).not.toContain("operator@example.com");
    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({ status: "terminal" });
    expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
  });

  it("joins concurrent consume calls into one provider request", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
      await input.beforeWrite?.();
      await input.afterWrite?.();
      await gate;
      return { outcome: "nothingToReset" as const };
    });

    const first = harness.service.consume(proposal.proposalId);
    const second = harness.service.consume(proposal.proposalId);
    await vi.waitFor(() => expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ outcome: "nothingToReset" }),
      expect.objectContaining({ outcome: "nothingToReset" }),
    ]));
  });

  it("blocks cancellation once consume starts and keeps one lease", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
      await input.beforeWrite?.();
      await input.afterWrite?.();
      await gate;
      return { outcome: "nothingToReset" as const };
    });

    const consuming = harness.service.consume(proposal.proposalId);
    await vi.waitFor(() => expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1));
    await expect(harness.service.cancel(proposal.proposalId)).rejects.toMatchObject({ code: "redemption-proposal-active" });
    expect(harness.store.releasePrepared).not.toHaveBeenCalled();
    release();
    await consuming;
  });

  it("invalidates before dispatch without provider mutation", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    harness.gateway.readAccount.mockResolvedValue({
      account: { type: "chatgpt", email: "other@example.com", plan: "pro" },
      providerRequiresOpenAiAuth: false,
    });

    await expect(harness.service.consume(proposal.proposalId)).rejects.toMatchObject({ code: "codex_account_changed" });
    expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();
    expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1);
  });

  it.each(["account", "rate-limits"] as const)(
    "cleans up prepared state when final %s read fails before dispatch",
    async (failedRead) => {
      const harness = consumeHarness();
      const proposal = await prepare(harness);
      if (failedRead === "account") harness.gateway.readAccount.mockRejectedValueOnce(new Error("transport"));
      else harness.gateway.readRateLimits.mockRejectedValueOnce(new Error("transport"));

      await expect(harness.service.consume(proposal.proposalId)).rejects.toMatchObject({ code: "codex_session_changed" });
      expect(harness.gateway.consumeResetCredit).not.toHaveBeenCalled();
      expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1);
    },
  );

  it("retains ambiguous lease after possible write transport loss", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
      await input.beforeWrite?.();
      await input.afterWrite?.();
      throw new CodexAccountGatewayError("transport-failed", "possibly-written");
    });

    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({
      status: "ambiguous",
      allowedAction: "retry-same",
    });
    expect(harness.store.transitionJournal).toHaveBeenLastCalledWith(
      proposal.proposalId,
      "n".repeat(43),
      "dispatched",
      expect.objectContaining({ phase: "ambiguous" }),
    );
    expect(harness.store.releasePrepared).not.toHaveBeenCalled();
    await expect(harness.service.state(proposal.proposalId)).resolves.toMatchObject({
      status: "ambiguous",
      allowedAction: "retry-same",
    });
  });

  it("rechecks account invalidation after awaited runtime identity proof before write", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    harness.qualifier.matchesIdentity
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        await harness.getSessionOptions().onNotification({ method: "account/updated", params: {} });
        return true;
      });

    await expect(harness.service.consume(proposal.proposalId)).rejects.toMatchObject({ code: "codex_session_changed" });
    expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
    expect(harness.events).not.toContain("provider-write");
    expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1);
  });

  it("replays terminal tombstone after downstream audit failure without another provider call", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    const readJournal = harness.store.readJournal.getMockImplementation()!;
    const releaseTerminal = harness.store.releaseTerminal.getMockImplementation()!;
    harness.store.readJournal.mockImplementation(function (this: unknown, ...args: any[]) {
      if (this !== harness.store) throw new Error("readJournal receiver lost");
      return readJournal(...args);
    });
    harness.store.releaseTerminal.mockImplementation(function (this: unknown, ...args: any[]) {
      if (this !== harness.store) throw new Error("releaseTerminal receiver lost");
      return releaseTerminal(...args);
    });
    harness.auditSink.mockRejectedValueOnce(new Error("stdout unavailable"));

    await expect(harness.service.consume(proposal.proposalId)).rejects.toMatchObject({ code: "codex_read_failed" });
    expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
    expect(harness.store.publishTombstone).toHaveBeenCalledTimes(1);
    expect(harness.store.releaseTerminal).not.toHaveBeenCalled();
    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({
      status: "terminal",
      outcome: "reset",
    });
    expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
    expect(harness.auditSink).toHaveBeenCalledTimes(2);
    expect(harness.store.releaseTerminal).toHaveBeenCalledTimes(1);
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({ status: "terminal" });
    expect(harness.auditSink).toHaveBeenCalledTimes(2);
  });

  it.each(["lease-release", "session-close"] as const)(
    "replays terminal tombstone after %s failure without another provider call",
    async (boundary) => {
      const harness = consumeHarness();
      const proposal = await prepare(harness);
      if (boundary === "lease-release") harness.store.releaseTerminal.mockRejectedValueOnce(new Error("release failed"));
      else harness.session.close.mockRejectedValueOnce(new Error("close failed"));

      await expect(harness.service.consume(proposal.proposalId)).rejects.toMatchObject({ code: "codex_read_failed" });
      await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({ status: "terminal" });
      expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
      expect(harness.auditSink).toHaveBeenCalledTimes(boundary === "lease-release" ? 2 : 1);
      expect(harness.store.releaseTerminal).toHaveBeenCalledTimes(boundary === "lease-release" ? 2 : 1);
      expect(harness.session.close).toHaveBeenCalledTimes(boundary === "session-close" ? 2 : 1);
    },
  );

  it.each(["terminal-persistence", "reconciliation-persistence", "tombstone-publication"] as const)(
    "fails closed at %s without audit, lease release, or a second provider call",
    async (boundary) => {
      const harness = consumeHarness();
      const proposal = await prepare(harness);
      if (boundary === "tombstone-publication") {
        harness.store.publishTombstone.mockRejectedValueOnce(new Error("tombstone failed"));
      } else {
        const transition = harness.store.transitionJournal.getMockImplementation()!;
        harness.store.transitionJournal.mockImplementation(async (...args: any[]) => {
          const expectedPhase = args[2];
          const next = args[3];
          if (
            (boundary === "terminal-persistence" && expectedPhase === "dispatched" && next.phase === "terminal") ||
            (boundary === "reconciliation-persistence" && expectedPhase === "terminal" && next.reconciliation !== "pending")
          ) throw new Error(`${boundary} failed`);
          return await transition(...args);
        });
      }

      await expect(harness.service.consume(proposal.proposalId)).rejects.toMatchObject({ code: "codex_read_failed" });
      expect(harness.auditSink).not.toHaveBeenCalled();
      expect(harness.store.releaseTerminal).not.toHaveBeenCalled();
      expect(harness.store.publishTombstone).toHaveBeenCalledTimes(boundary === "tombstone-publication" ? 1 : 0);
      expect(harness.session.close).not.toHaveBeenCalled();
      await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({ status: "processing" });
      expect(harness.gateway.consumeResetCredit).toHaveBeenCalledTimes(1);
    },
  );

  it("marks reconciliation unreconciled when account invalidates after dispatch", async () => {
    const harness = consumeHarness();
    const proposal = await prepare(harness);
    harness.gateway.consumeResetCredit.mockImplementation(async (input) => {
      await input.beforeWrite?.();
      await input.afterWrite?.();
      await harness.getSessionOptions().onNotification({ method: "account/updated", params: {} });
      return { outcome: "reset" as const };
    });

    await expect(harness.service.consume(proposal.proposalId)).resolves.toMatchObject({
      status: "terminal",
      reconciliation: "unreconciled",
      message: "Reset completed; current usage unavailable.",
    });
    expect(harness.gateway.readRateLimits).toHaveBeenCalledTimes(2);
  });
});
