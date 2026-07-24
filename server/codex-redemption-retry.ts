import type { CodexRedemptionCurrentView } from "../shared/codex-account-types.js";
import {
  CodexAccountGatewayError,
  type CodexConsumeResetCreditOutcome,
} from "./codex-account-gateway.js";
import type { CodexRedemptionAuditSink } from "./codex-redemption-audit.js";
import { CodexRedemptionConsumeError } from "./codex-redemption-consume-error.js";
import type { RedemptionJournal, TerminalRedemptionTombstone } from "./codex-redemption-journal.js";
import { CodexRedemptionRecoveryError } from "./codex-redemption-recovery-error.js";
import type { CodexRuntimeIdentity, CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";
import { finalizeRedemptionOutcome } from "./codex-redemption-terminal-finalize.js";

export type RetryGateway = {
  readRateLimits(): Promise<import("./codex-account-gateway.js").CodexRateLimitsRead>;
  consumeResetCredit?: (input: {
    idempotencyKey: string;
    creditId?: string;
    timeoutMs?: number;
    beforeWrite?: () => Promise<void> | void;
    afterWrite?: () => Promise<void> | void;
  }) => Promise<{ outcome: CodexConsumeResetCreditOutcome }>;
};

export type RetryStore = {
  transitionJournal(
    proposalId: string,
    ownerNonce: string,
    expectedPhase: RedemptionJournal["phase"],
    next: RedemptionJournal,
  ): Promise<RedemptionJournal>;
  publishTombstone(tombstone: TerminalRedemptionTombstone): Promise<void>;
  releaseTerminal(proposalId: string, ownerNonce: string, auditEventId: string): Promise<void>;
};

export async function retryAmbiguousRedemption(dependencies: {
  active: {
    journal: RedemptionJournal;
    session: { close(): Promise<void> };
    invalidated: boolean;
  };
  gateway: RetryGateway;
  store: RetryStore;
  qualifier: CodexRuntimeQualifierLike;
  runtimeIdentity: CodexRuntimeIdentity;
  now: () => Date;
    auditSink: CodexRedemptionAuditSink;
    codexVersion: string;
    account: { email: string; plan: string };
}): Promise<CodexRedemptionCurrentView> {
    const { active, gateway } = dependencies;
    if (active.journal.phase !== "ambiguous" || !gateway.consumeResetCredit) {
      throw new CodexRedemptionConsumeError("redemption-recovery-required");
    }
    const journal = active.journal;
    const beforeWrite = async () => {
      if (active.invalidated) {
        throw new CodexRedemptionConsumeError("codex_session_changed");
      }
      const identityMatches = await dependencies.qualifier.matchesIdentity(dependencies.runtimeIdentity);
      if (active.invalidated || !identityMatches) {
        throw new CodexRedemptionConsumeError("codex_session_changed");
      }
  };
  let result: { outcome: CodexConsumeResetCreditOutcome };
  try {
    result = await gateway.consumeResetCredit({
        idempotencyKey: journal.idempotencyKey,
        ...(journal.selection.mode === "specific" ? { creditId: journal.selection.creditId } : {}),
      timeoutMs: 20_000,
      beforeWrite,
      afterWrite: async () => {},
    });
  } catch (error) {
    if (
        error instanceof CodexAccountGatewayError &&
        error.writeDisposition === "not-written" &&
        error.hookErrorCode === "codex_session_changed"
      ) throw new CodexRedemptionRecoveryError("codex_recovery_session_changed");
    return {
        status: "ambiguous",
        proposalId: journal.proposalId,
        allowedAction: "retry-same",
        selectionMode: journal.selection.mode,
        dispatchAt: journal.dispatchAt,
    };
  }
  return await finalizeRedemptionOutcome({
    active,
    gateway,
    store: dependencies.store,
    now: dependencies.now,
      auditSink: dependencies.auditSink,
      codexVersion: dependencies.codexVersion,
      account: dependencies.account,
      outcome: result.outcome,
    expectedPhase: "ambiguous",
  });
}
