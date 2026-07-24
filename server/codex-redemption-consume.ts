import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
} from "../shared/codex-account-types.js";
import {
  CodexAccountGatewayError,
  type CodexAccountRead,
  type CodexConsumeResetCreditOutcome,
  type CodexRateLimitsRead,
} from "./codex-account-gateway.js";
import type { CodexRedemptionAuditSink } from "./codex-redemption-audit.js";
import {
    parseRedemptionJournal,
    type RedemptionJournal,
    type RedemptionJournalPatch,
    type RedemptionJournalPhase,
  type TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";
import type { CodexRuntimeIdentity, CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";
import { finalizeRedemptionOutcome } from "./codex-redemption-terminal-finalize.js";
import { CodexRedemptionConsumeError } from "./codex-redemption-consume-error.js";
export { CodexRedemptionConsumeError } from "./codex-redemption-consume-error.js";

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
  runtimeIdentity: CodexRuntimeIdentity;
  now: () => Date;
  auditSink: CodexRedemptionAuditSink;
  codexVersion: string;
};

function nextJournal(active: RedemptionJournal, patch: RedemptionJournalPatch): RedemptionJournal {
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
  if (!account.account || account.account.type !== "chatgpt") {
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
        if (active.journal.phase !== "ambiguous") throw new CodexRedemptionConsumeError("redemption-recovery-required");
        return {
        status: "ambiguous",
        proposalId: active.journal.proposalId,
          allowedAction: "retry-same",
        selectionMode: active.journal.selection.mode,
          dispatchAt: active.journal.dispatchAt,
      };
    }
    throw new CodexRedemptionConsumeError("redemption-recovery-required");
  }
  return await finalizeRedemptionOutcome({
    active,
    gateway,
    store,
    now,
      auditSink: dependencies.auditSink,
      codexVersion: dependencies.codexVersion,
      account: active.proposal.account,
      outcome: result.outcome,
    expectedPhase: "dispatched",
    initialRateLimits: rateLimits,
  });
}
