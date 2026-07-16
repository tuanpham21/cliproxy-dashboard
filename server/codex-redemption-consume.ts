import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
  CodexRedemptionUsageSnapshot,
} from "../shared/codex-account-types.js";
import {
  CodexAccountGatewayError,
  type CodexAccountRead,
  type CodexConsumeResetCreditOutcome,
  type CodexRateLimitsRead,
} from "./codex-account-gateway.js";
import {
  newRedemptionAuditEventId,
  type CodexRedemptionAuditSink,
} from "./codex-redemption-audit.js";
import {
  parseRedemptionJournal,
  type RedemptionJournal,
  type RedemptionJournalPhase,
  type RedemptionReconciliation,
  type TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";
import type { CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";

export type ConsumeErrorCode =
  | "codex_account_changed"
  | "codex_reset_availability_changed"
  | "codex_session_changed"
  | "codex_proposal_expired"
  | "redemption-recovery-required";

export class CodexRedemptionConsumeError extends Error {
  readonly code: ConsumeErrorCode;

  constructor(code: ConsumeErrorCode) {
    super(code);
    this.name = "CodexRedemptionConsumeError";
    this.code = code;
  }
}

export type ConsumeSession = {
  close(): Promise<void>;
};

export type ConsumeGateway = {
  readAccount(): Promise<CodexAccountRead>;
  readRateLimits(): Promise<CodexRateLimitsRead>;
  consumeResetCredit?: (input: {
    idempotencyKey: string;
    creditId?: string;
    timeoutMs?: number;
    beforeWrite?: () => Promise<void> | void;
    afterWrite?: () => Promise<void> | void;
  }) => Promise<{ outcome: CodexConsumeResetCreditOutcome }>;
};

export type ConsumeStore = {
  transitionJournal(
    proposalId: string,
    ownerNonce: string,
    expectedPhase: RedemptionJournal["phase"],
    next: RedemptionJournal,
  ): Promise<RedemptionJournal>;
  publishTombstone(tombstone: TerminalRedemptionTombstone): Promise<void>;
  releaseTerminal(proposalId: string, ownerNonce: string, auditEventId: string): Promise<void>;
  readJournal(proposalId: string, ownerNonce: string): Promise<RedemptionJournal | null>;
};

export type ConsumeActiveProposal = {
  proposal: CodexRedemptionProposalView;
  journal: RedemptionJournal;
  session: ConsumeSession;
  invalidated: boolean;
};

export type ConsumeDependencies = {
  active: ConsumeActiveProposal;
  gateway: ConsumeGateway;
  store: ConsumeStore;
  qualifier: CodexRuntimeQualifierLike;
  runtimeIdentity: { canonicalPath: string; version: string; fileIdentity: string; schemaHash: string };
  now: () => Date;
  auditSink: CodexRedemptionAuditSink;
  codexVersion: string;
};

function terminalMessage(outcome: CodexConsumeResetCreditOutcome, selectionMode: "specific" | "generic", reconciliation: RedemptionReconciliation): string {
  if (reconciliation === "unreconciled" || reconciliation === "availability-changed-unreconciled") {
    return outcome === "noCredit"
      ? "Reset availability changed; current usage could not be refreshed."
      : "Reset completed; current usage unavailable.";
  }
  if (outcome === "reset") return "Usage limits reset. Checking current usage…";
  if (outcome === "alreadyRedeemed") return "This redemption was already completed. Checking current usage…";
  if (outcome === "nothingToReset") return "No eligible usage limit needs a reset right now. No reset was applied.";
  return selectionMode === "specific"
    ? "That reset is no longer available. Refreshing account usage…"
    : "No usage limit resets are available. Refreshing account usage…";
}

function secondsToIso(value: number | null): string | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function usageSnapshot(read: CodexRateLimitsRead, observedAt: string): CodexRedemptionUsageSnapshot {
  const window = (value: CodexRateLimitsRead["rateLimits"]["primary"]) => value ? {
    usedPercent: Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100 ? value.usedPercent : null,
    durationMinutes: value.windowMinutes !== null && value.windowMinutes >= 0 ? value.windowMinutes : null,
    resetsAt: secondsToIso(value.resetsAt),
  } : null;
  const credits = (read.resetCredits?.credits ?? []).map((credit) => ({
    id: credit.id,
    availability: credit.availability,
    title: credit.title,
    description: credit.description,
    grantedAt: secondsToIso(credit.grantedAt),
    expiresAt: secondsToIso(credit.expiresAt),
  }));
  const availableCount = read.resetCredits?.availableCount ?? 0;
  return {
    observedAt,
    usage: { primary: window(read.rateLimits.primary), secondary: window(read.rateLimits.secondary) },
    resetCredits: {
      availableCount,
      selectionMode: availableCount <= 0
        ? "none"
        : credits.some((credit) => credit.availability === "available" && Boolean(credit.id))
          ? "detailed"
          : "generic",
      credits,
    },
  };
}

function publicTerminal(
  tombstone: TerminalRedemptionTombstone,
  accountUsage?: CodexRedemptionUsageSnapshot,
): CodexRedemptionCurrentView {
  return {
    status: "terminal",
    proposalId: tombstone.proposalId,
    allowedAction: "none",
    selectionMode: tombstone.selectionMode,
    outcome: tombstone.outcome,
    reconciliation: tombstone.reconciliation,
    message: tombstone.message,
    auditEventId: tombstone.auditEventId,
    createdAt: tombstone.createdAt,
    expiresAt: tombstone.expiresAt,
    ...(accountUsage ? { accountUsage } : {}),
  };
}

function nextJournal(active: RedemptionJournal, patch: Partial<RedemptionJournal>): RedemptionJournal {
  const candidate = { ...active, ...patch } as Record<string, unknown>;
  if (candidate.phase === "prepared") {
    delete candidate.dispatchAt;
    delete candidate.terminalAt;
    delete candidate.outcome;
    delete candidate.reconciliation;
    delete candidate.auditEventId;
  }
  const parsed = parseRedemptionJournal(candidate);
  if (!parsed) throw new CodexRedemptionConsumeError("redemption-recovery-required");
  return parsed;
}

export async function consumePrepared(dependencies: ConsumeDependencies): Promise<CodexRedemptionCurrentView> {
  const { active, gateway, store, now } = dependencies;
  if (active.journal.phase !== "prepared") throw new CodexRedemptionConsumeError("redemption-recovery-required");
  if (Date.parse(active.journal.expiresAt) <= now().getTime()) throw new CodexRedemptionConsumeError("codex_proposal_expired");
  let account;
  try {
    account = await gateway.readAccount();
  } catch {
    throw new CodexRedemptionConsumeError("codex_session_changed");
  }
  if (account.requiresOpenAiAuth || !account.account || account.account.type !== "chatgpt") {
    throw new CodexRedemptionConsumeError("codex_account_changed");
  }
  if (account.account.email !== active.proposal.account.email || account.account.plan !== active.proposal.account.plan) {
    throw new CodexRedemptionConsumeError("codex_account_changed");
  }
  let rateLimits;
  try {
    rateLimits = await gateway.readRateLimits();
  } catch {
    throw new CodexRedemptionConsumeError("codex_session_changed");
  }
  const credits = rateLimits.resetCredits;
  if (!credits || credits.availableCount <= 0) throw new CodexRedemptionConsumeError("codex_reset_availability_changed");
  if (active.proposal.selection.mode === "specific") {
    const selected = (credits.credits ?? []).find((credit) => credit.id === (
      active.journal.selection.mode === "specific" ? active.journal.selection.creditId : null
    ));
    if (!selected || selected.availability !== "available") throw new CodexRedemptionConsumeError("codex_reset_availability_changed");
  }
  if (active.invalidated || !(await dependencies.qualifier.matchesIdentity(dependencies.runtimeIdentity))) {
    throw new CodexRedemptionConsumeError("codex_session_changed");
  }
  if (!gateway.consumeResetCredit) throw new CodexRedemptionConsumeError("redemption-recovery-required");
  const dispatchAt = now().toISOString();
  const idempotencyKey = active.journal.idempotencyKey;
  const beforeWrite = async () => {
    if (active.invalidated || Date.parse(active.journal.expiresAt) <= now().getTime()) {
      throw new CodexRedemptionConsumeError(active.invalidated ? "codex_session_changed" : "codex_proposal_expired");
    }
    if (!(await dependencies.qualifier.matchesIdentity(dependencies.runtimeIdentity))) {
      throw new CodexRedemptionConsumeError("codex_session_changed");
    }
    if (active.invalidated || Date.parse(active.journal.expiresAt) <= now().getTime()) {
      throw new CodexRedemptionConsumeError(active.invalidated ? "codex_session_changed" : "codex_proposal_expired");
    }
    active.journal = await store.transitionJournal(
      active.journal.proposalId,
      active.journal.ownerNonce,
      "prepared",
      nextJournal(active.journal, { phase: "dispatch-intent", dispatchAt, updatedAt: dispatchAt }),
    );
  };
  const afterWrite = async () => {
    active.journal = await store.transitionJournal(
      active.journal.proposalId,
      active.journal.ownerNonce,
      "dispatch-intent",
      nextJournal(active.journal, { phase: "dispatched", updatedAt: now().toISOString() }),
    );
  };
  let result: { outcome: CodexConsumeResetCreditOutcome };
  try {
    result = await gateway.consumeResetCredit({
      idempotencyKey,
      creditId: active.journal.selection.mode === "specific" ? active.journal.selection.creditId : undefined,
      timeoutMs: 20_000,
      beforeWrite,
      afterWrite,
    });
  } catch (error) {
    const writeDisposition = error instanceof CodexAccountGatewayError ? error.writeDisposition : undefined;
    const hookErrorCode = error instanceof CodexAccountGatewayError ? error.hookErrorCode : undefined;
    const authoritative = await store.readJournal(active.journal.proposalId, active.journal.ownerNonce).catch(() => null);
    if (authoritative) active.journal = authoritative;
    const phaseAfterError = active.journal.phase as RedemptionJournalPhase;
    if (writeDisposition === "not-written" && phaseAfterError === "prepared" && (
      hookErrorCode === "codex_session_changed" || hookErrorCode === "codex_proposal_expired"
    )) throw new CodexRedemptionConsumeError(hookErrorCode);
    if (writeDisposition === "not-written" && phaseAfterError === "dispatch-intent") {
      active.journal = await store.transitionJournal(
        active.journal.proposalId,
        active.journal.ownerNonce,
        "dispatch-intent",
        nextJournal(active.journal, { phase: "prepared", updatedAt: now().toISOString(), dispatchAt: undefined }),
      );
      throw new CodexRedemptionConsumeError(
        hookErrorCode === "codex_proposal_expired" ? "codex_proposal_expired" : "codex_session_changed",
      );
    }
    if (phaseAfterError === "dispatch-intent" || phaseAfterError === "dispatched") {
      active.journal = await store.transitionJournal(
        active.journal.proposalId,
        active.journal.ownerNonce,
        phaseAfterError,
        nextJournal(active.journal, { phase: "ambiguous", updatedAt: now().toISOString() }),
      );
      return {
        status: "ambiguous",
        proposalId: active.journal.proposalId,
        allowedAction: "none",
        selectionMode: active.journal.selection.mode,
        dispatchAt: active.journal.dispatchAt!,
      };
    }
    throw new CodexRedemptionConsumeError("redemption-recovery-required");
  }
  const outcome = result.outcome;
  const auditEventId = newRedemptionAuditEventId();
  const initialReconciliation: RedemptionReconciliation = outcome === "nothingToReset" ? "not-required" : "pending";
  active.journal = await store.transitionJournal(
    active.journal.proposalId,
    active.journal.ownerNonce,
    "dispatched",
    nextJournal(active.journal, {
      phase: "terminal",
      terminalAt: now().toISOString(),
      outcome,
      reconciliation: initialReconciliation,
      auditEventId,
      updatedAt: now().toISOString(),
    }),
  );
  let reconciliation: RedemptionReconciliation = initialReconciliation;
  let reconciledRead: CodexRateLimitsRead | null = outcome === "nothingToReset" ? rateLimits : null;
  if (outcome !== "nothingToReset") {
    try {
      if (active.invalidated) throw new Error("session invalidated");
      reconciledRead = await gateway.readRateLimits();
      if (active.invalidated) throw new Error("session invalidated");
      reconciliation = "reconciled";
    } catch {
      reconciliation = outcome === "noCredit" ? "availability-changed-unreconciled" : "unreconciled";
    }
    active.journal = await store.transitionJournal(
      active.journal.proposalId,
      active.journal.ownerNonce,
      "terminal",
      nextJournal(active.journal, { reconciliation, updatedAt: now().toISOString() }),
    );
  }
  const tombstone: TerminalRedemptionTombstone = {
    schemaVersion: 1,
    proposalId: active.proposal.proposalId,
    selectionMode: active.proposal.selection.mode,
    outcome,
    reconciliation: reconciliation as Exclude<RedemptionReconciliation, "pending">,
    auditEventId,
    message: terminalMessage(outcome, active.proposal.selection.mode, reconciliation),
    createdAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + 600_000).toISOString(),
  };
  await store.publishTombstone(tombstone);
  await dependencies.auditSink({
    eventId: auditEventId,
    event: "codex_redemption_terminal",
    timestamp: tombstone.createdAt,
    outcome,
    codexVersion: dependencies.codexVersion,
    selectionMode: tombstone.selectionMode,
    reconciliation,
  });
  await store.releaseTerminal(active.proposal.proposalId, active.journal.ownerNonce, auditEventId);
  await active.session.close();
  return publicTerminal(tombstone, reconciledRead ? usageSnapshot(reconciledRead, tombstone.createdAt) : undefined);
}
