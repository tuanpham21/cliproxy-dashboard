import { describe, expect, it, vi } from "vitest";

import type { CodexRateLimitsRead } from "../codex-account-gateway.js";
import {
  CodexRedemptionPrivateStateError,
  type PublicPrivateRedemptionState,
} from "../codex-redemption-private-state.js";
import { CodexRedemptionService } from "../codex-redemption-service.js";
import type { CodexRuntimeQualification } from "../codex-runtime-qualifier.js";

const qualified: CodexRuntimeQualification = {
  status: "qualified",
  version: "codex-cli 0.144.4",
  identity: {
    canonicalPath: "/opt/codex/bin/codex",
    codexStateRoot: "/home/operator/.codex",
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
    secondary: { usedPercent: 60, windowMinutes: 10_080, resetsAt: 1_800_604_800 },
    plan: "pro",
  },
  rateLimitsByLimitId: null,
  resetCredits: {
    availableCount: 2,
    credits: [
      {
        id: "credit-1",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1_700_000_000,
        expiresAt: 1_900_000_000,
        title: "Early reset",
        description: "Provider chooses eligible windows.",
        availability: "available",
      },
    ],
  },
};

function serviceHarness() {
  const events: string[] = [];
  let publicState: PublicPrivateRedemptionState = { status: "not-found" };
  const session = { close: vi.fn(async () => {}) };
  const consumeResetCredit = vi.fn();
  const gateway = {
    readAccount: vi.fn(async () => {
      events.push("account");
      return {
        account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
        requiresOpenAiAuth: false,
      };
    }),
    readRateLimits: vi.fn(async () => {
      events.push("rate-limits");
      return rateLimits;
    }),
    consumeResetCredit,
  };
  const acquirePrepared = vi.fn(async (input) => {
    events.push("lease");
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
    return journal;
  });
  const store = {
    acquirePrepared,
    releasePrepared: vi.fn(async () => {
      publicState = { status: "not-found" };
    }),
    readPublicState: vi.fn(async () => publicState),
  };
  const schedule = vi.fn(() => ({ timer: true }) as unknown as NodeJS.Timeout);
  const now = vi.fn(() => new Date("2026-07-16T12:00:00.000Z"));
  const startSession = vi.fn(async (options) => {
    events.push("session");
    expect(options.onNotification).toEqual(expect.any(Function));
    expect(options.onUnexpectedProcessClose).toEqual(expect.any(Function));
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
    now,
    newProposalId: () => "p".repeat(43),
    newIdempotencyKey: () => "11111111-2222-4333-8444-555555555555",
    schedule,
    clearScheduled: vi.fn(),
  });
  return { service, events, session, gateway, store, schedule, startSession, qualifier, consumeResetCredit, now };
}

describe("Codex redemption service", () => {
  it("prepares a specific reset from fresh reads before publishing the two-minute lease", async () => {
    const harness = serviceHarness();

    await expect(harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).resolves.toEqual({
      status: "prepared",
      proposalId: "p".repeat(43),
      allowedAction: "cancel",
      createdAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
      account: { email: "operator@example.com", plan: "pro" },
      usage: {
        primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2027-01-15T08:00:00.000Z" },
        secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: "2027-01-22T08:00:00.000Z" },
      },
      availableCount: 2,
      selection: {
        mode: "specific",
        title: "Early reset",
        description: "Provider chooses eligible windows.",
        expiresAt: "2030-03-17T17:46:40.000Z",
      },
    });
    expect(harness.events).toEqual(["session", "account", "rate-limits", "lease"]);
    expect(harness.store.acquirePrepared).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: "p".repeat(43),
      idempotencyKey: "11111111-2222-4333-8444-555555555555",
      selection: { mode: "specific", creditId: "credit-1" },
      accountCheck: { email: "operator@example.com", plan: "pro" },
    }));
    expect(harness.schedule).toHaveBeenCalledWith(expect.any(Function), 120_000);
    expect(harness.session.close).not.toHaveBeenCalled();
    expect(harness.consumeResetCredit).not.toHaveBeenCalled();
  });

  it("prepares generic provider selection only when positive count has no usable detail", async () => {
    const harness = serviceHarness();
    harness.gateway.readRateLimits.mockResolvedValue({
      ...rateLimits,
      resetCredits: {
        availableCount: 1,
        credits: [{ ...rateLimits.resetCredits!.credits![0], id: null, availability: "malformed" }],
      },
    });

    await expect(harness.service.prepare("codex", {
      singleWorkspaceAttested: true,
    })).resolves.toMatchObject({
      availableCount: 1,
      selection: { mode: "generic" },
    });
    expect(harness.store.acquirePrepared).toHaveBeenCalledWith(expect.objectContaining({
      selection: { mode: "generic" },
    }));
  });

  it("rejects missing attestation and detailed/generic selection tampering before lease publication", async () => {
    const unattested = serviceHarness();
    await expect(unattested.service.prepare("codex", {
      singleWorkspaceAttested: false,
    } as never)).rejects.toMatchObject({ code: "redemption-attestation-required" });
    expect(unattested.qualifier.qualify).not.toHaveBeenCalled();

    const missingDetail = serviceHarness();
    await expect(missingDetail.service.prepare("codex", {
      singleWorkspaceAttested: true,
    })).rejects.toMatchObject({ code: "redemption-selection-invalid" });
    expect(missingDetail.store.acquirePrepared).not.toHaveBeenCalled();
    expect(missingDetail.session.close).toHaveBeenCalledTimes(1);

    const forcedDetail = serviceHarness();
    forcedDetail.gateway.readRateLimits.mockResolvedValue({
      ...rateLimits,
      resetCredits: {
        availableCount: 1,
        credits: [{ ...rateLimits.resetCredits!.credits![0], id: null, availability: "malformed" }],
      },
    });
    await expect(forcedDetail.service.prepare("codex", {
      creditId: "client-forced-credit",
      singleWorkspaceAttested: true,
    })).rejects.toMatchObject({ code: "redemption-selection-invalid" });
    expect(forcedDetail.store.acquirePrepared).not.toHaveBeenCalled();
    expect(forcedDetail.session.close).toHaveBeenCalledTimes(1);
  });

  it("closes the dedicated session when another process wins lease publication", async () => {
    const harness = serviceHarness();
    harness.store.acquirePrepared.mockRejectedValue(
      new CodexRedemptionPrivateStateError("redemption-proposal-active"),
    );

    await expect(harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).rejects.toMatchObject({
      code: "redemption-proposal-active",
      message: "Another reset redemption proposal is already active.",
    });
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.consumeResetCredit).not.toHaveBeenCalled();
  });

  it("shares one idempotent cleanup transition across cancel and server expiry", async () => {
    const harness = serviceHarness();
    const proposal = await harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    await expect(harness.service.state(proposal.proposalId)).resolves.toMatchObject({
      status: "prepared",
      allowedAction: "cancel",
      selectionMode: "specific",
    });
    expect(harness.store.readPublicState).toHaveBeenCalledTimes(1);

    const expire = harness.schedule.mock.calls[0][0];
    const cancelling = harness.service.cancel(proposal.proposalId);
    expire();
    await expect(cancelling).resolves.toEqual({ status: "cancelled", proposalId: proposal.proposalId });

    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1);
    await expect(harness.service.state(proposal.proposalId)).resolves.toEqual({ status: "not-found" });
    expect(harness.store.readPublicState).toHaveBeenCalledTimes(2);
    await expect(harness.service.cancel(proposal.proposalId)).rejects.toMatchObject({
      code: "redemption-proposal-not-found",
    });
    expect(harness.consumeResetCredit).not.toHaveBeenCalled();
  });

  it("waits for cleanup before polling so normal cancel cannot look corrupt", async () => {
    const harness = serviceHarness();
    const proposal = await harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    harness.store.releasePrepared.mockImplementation(async () => {
      await gate;
      harness.store.readPublicState.mockResolvedValue({ status: "not-found" });
    });

    const cancelling = harness.service.cancel(proposal.proposalId);
    await vi.waitFor(() => expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1));
    const polling = harness.service.state(proposal.proposalId);
    await Promise.resolve();
    expect(harness.store.readPublicState).not.toHaveBeenCalled();
    release();

    await expect(cancelling).resolves.toEqual({ status: "cancelled", proposalId: proposal.proposalId });
    await expect(polling).resolves.toEqual({ status: "not-found" });
  });

  it("rechecks cleanup when cancellation starts during a private-state read", async () => {
    const harness = serviceHarness();
    const proposal = await harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    let finishRead!: () => void;
    const readGate = new Promise<void>((resolve) => { finishRead = resolve; });
    harness.store.readPublicState.mockImplementationOnce(async () => {
      await readGate;
      return {
        status: "prepared",
        proposalId: proposal.proposalId,
        selectionMode: "specific",
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
      };
    });

    const polling = harness.service.state(proposal.proposalId);
    await vi.waitFor(() => expect(harness.store.readPublicState).toHaveBeenCalledTimes(1));
    const cancelling = harness.service.cancel(proposal.proposalId);
    await vi.waitFor(() => expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1));
    finishRead();

    await expect(cancelling).resolves.toEqual({ status: "cancelled", proposalId: proposal.proposalId });
    await expect(polling).resolves.toEqual({ status: "not-found" });
    expect(harness.store.readPublicState).toHaveBeenCalledTimes(2);
  });

  it("invalidates prepared state on account change or unexpected app-server closure", async () => {
    const accountChanged = serviceHarness();
    const first = await accountChanged.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    const firstOptions = accountChanged.startSession.mock.calls[0][0];
    await firstOptions.onNotification({ method: "thread/updated", params: {} });
    expect(accountChanged.session.close).not.toHaveBeenCalled();
    await firstOptions.onNotification({ method: "account/updated", params: {} });
    await vi.waitFor(() => expect(accountChanged.store.releasePrepared).toHaveBeenCalledTimes(1));
    await expect(accountChanged.service.state(first.proposalId)).resolves.toEqual({ status: "not-found" });

    const processClosed = serviceHarness();
    await processClosed.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    const secondOptions = processClosed.startSession.mock.calls[0][0];
    await secondOptions.onUnexpectedProcessClose();
    await vi.waitFor(() => expect(processClosed.store.releasePrepared).toHaveBeenCalledTimes(1));
    expect(processClosed.session.close).toHaveBeenCalledTimes(1);
    expect(processClosed.consumeResetCredit).not.toHaveBeenCalled();
  });

  it("polls private public state without qualification, session, account, lease, or TTL work", async () => {
    const harness = serviceHarness();
    harness.store.readPublicState.mockResolvedValue({
      status: "prepared",
      proposalId: "p".repeat(43),
      selectionMode: "generic",
      createdAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
    });

    await expect(harness.service.state("p".repeat(43))).resolves.toEqual({
      status: "prepared",
      proposalId: "p".repeat(43),
      allowedAction: "poll",
      selectionMode: "generic",
      createdAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
    });
    expect(harness.store.readPublicState).toHaveBeenCalledTimes(1);
    expect(harness.qualifier.qualify).not.toHaveBeenCalled();
    expect(harness.startSession).not.toHaveBeenCalled();
    expect(harness.gateway.readAccount).not.toHaveBeenCalled();
    expect(harness.store.acquirePrepared).not.toHaveBeenCalled();
    expect(harness.schedule).not.toHaveBeenCalled();
    expect(harness.consumeResetCredit).not.toHaveBeenCalled();
  });

  it("reports private corruption instead of trusting in-memory prepared state", async () => {
    const harness = serviceHarness();
    const proposal = await harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    harness.store.readPublicState.mockResolvedValue({
      status: "recovery-required",
      code: "redemption-recovery-required",
      message: "Reset redemption recovery state requires local repair.",
    });

    await expect(harness.service.state(proposal.proposalId)).resolves.toMatchObject({
      status: "recovery-required",
      code: "redemption-recovery-required",
    });
  });

  it("exposes browser-safe active proposal context for reconnect discovery", async () => {
    const harness = serviceHarness();
    const proposal = await harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });

    await expect(harness.service.currentState()).resolves.toEqual(proposal);
    expect(JSON.stringify(await harness.service.currentState())).not.toContain("credit-1");
    expect(JSON.stringify(await harness.service.currentState())).not.toContain("11111111-2222-4333-8444-555555555555");
  });

  it("lets the server timer expire prepared state without a browser cancel request", async () => {
    const harness = serviceHarness();
    const proposal = await harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });

    harness.schedule.mock.calls[0][0]();
    await vi.waitFor(() => expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1));

    expect(harness.session.close).toHaveBeenCalledTimes(1);
    await expect(harness.service.state(proposal.proposalId)).resolves.toEqual({ status: "not-found" });
    expect(harness.consumeResetCredit).not.toHaveBeenCalled();
  });

  it("reports recovery-required when prepared cleanup cannot release private state", async () => {
    const harness = serviceHarness();
    const proposal = await harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    harness.store.releasePrepared.mockRejectedValue(
      new CodexRedemptionPrivateStateError("redemption-recovery-required"),
    );

    await expect(harness.service.cancel(proposal.proposalId)).rejects.toMatchObject({
      code: "redemption-recovery-required",
    });
    await expect(harness.service.state(proposal.proposalId)).resolves.toEqual({
      status: "recovery-required",
      code: "redemption-recovery-required",
      message: "Reset redemption recovery state requires local repair.",
    });
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(harness.store.releasePrepared).toHaveBeenCalledTimes(1);
  });

  it("keeps the prepared lease when abort cleanup cannot close its app-server session", async () => {
    const harness = serviceHarness();
    harness.schedule.mockImplementation(() => {
      throw new Error("timer unavailable");
    });
    harness.session.close.mockRejectedValue(new Error("process still running"));

    await expect(harness.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).rejects.toMatchObject({ code: "redemption-recovery-required" });
    expect(harness.session.close).toHaveBeenCalledTimes(1);
    expect(harness.store.releasePrepared).not.toHaveBeenCalled();
  });

  it("schedules only the TTL remaining after lease publication and aborts an already-expired proposal", async () => {
    const delayed = serviceHarness();
    delayed.now
      .mockReturnValueOnce(new Date("2026-07-16T12:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-07-16T12:00:05.000Z"));
    await delayed.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
    expect(delayed.schedule).toHaveBeenCalledWith(expect.any(Function), 115_000);

    const expired = serviceHarness();
    expired.now
      .mockReturnValueOnce(new Date("2026-07-16T12:00:00.000Z"))
      .mockReturnValueOnce(new Date("2026-07-16T12:02:01.000Z"));
    await expect(expired.service.prepare("codex", {
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    })).rejects.toMatchObject({ code: "redemption-proposal-invalidated" });
    expect(expired.schedule).not.toHaveBeenCalled();
    expect(expired.session.close).toHaveBeenCalledTimes(1);
    expect(expired.store.releasePrepared).toHaveBeenCalledTimes(1);
  });
});
