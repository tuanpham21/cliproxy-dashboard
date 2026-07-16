import type {
  CodexAccountRead,
  CodexRateLimitsRead,
} from "./codex-account-gateway.js";
import type { CodexRedemptionAuditSink } from "./codex-redemption-audit.js";
import {
  terminalTombstoneMatchesJournal,
  type RedemptionJournal,
  type RedemptionReconciliation,
  type TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";
import type { CodexRuntimeIdentity, CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";
import { terminalMessage } from "./codex-redemption-terminal-message.js";

type TerminalRecoverySession = { close(): Promise<void> };
type TerminalRecoveryGateway = {
  readAccount(): Promise<CodexAccountRead>;
  readRateLimits(): Promise<CodexRateLimitsRead>;
};

export type TerminalRecoveryStore = {
  readTombstone(proposalId: string): Promise<TerminalRedemptionTombstone | null>;
  verifyRecoveryEvidence(
    journal: RedemptionJournal,
    evidence: { accountCheck: { email: string; plan: string }; runtimeIdentity: CodexRuntimeIdentity },
  ): Promise<{ accountMatches: boolean; runtimeMatches: boolean }>;
  transitionJournal(
    proposalId: string,
    ownerNonce: string,
    expectedPhase: RedemptionJournal["phase"],
    next: RedemptionJournal,
  ): Promise<RedemptionJournal>;
  publishTombstone(tombstone: TerminalRedemptionTombstone): Promise<void>;
  releaseTerminal(proposalId: string, ownerNonce: string, auditEventId: string): Promise<void>;
};

function finalReconciliation(journal: RedemptionJournal): Exclude<RedemptionReconciliation, "pending"> | null {
  return journal.phase === "terminal" && journal.reconciliation && journal.reconciliation !== "pending"
    ? journal.reconciliation
    : null;
}

export async function recoverTerminalJournal(dependencies: {
  journal: RedemptionJournal;
  codexBin: string;
  qualifier: CodexRuntimeQualifierLike;
  startSession: (options: {
    codexBin: string;
    onNotification: (notification: { method: string; params?: unknown }) => Promise<void> | void;
    onUnexpectedProcessClose: () => Promise<void> | void;
  }) => Promise<TerminalRecoverySession>;
  gatewayForSession: (session: TerminalRecoverySession) => TerminalRecoveryGateway;
  store: TerminalRecoveryStore;
  now: () => Date;
  auditSink: CodexRedemptionAuditSink;
}): Promise<boolean> {
  let journal = dependencies.journal;
  if (journal.phase !== "terminal" || !journal.outcome || !journal.auditEventId) return false;
  const outcome = journal.outcome;
  const auditEventId = journal.auditEventId;
  const existingTombstone = await dependencies.store.readTombstone(journal.proposalId);
  if (existingTombstone) {
    if (
      !terminalTombstoneMatchesJournal(journal, existingTombstone)
    ) return false;
    await dependencies.auditSink({
      eventId: existingTombstone.auditEventId,
      event: "codex_redemption_terminal",
      timestamp: existingTombstone.createdAt,
      outcome: existingTombstone.outcome,
      codexVersion: journal.runtimeIdentity.version,
      selectionMode: existingTombstone.selectionMode,
      reconciliation: existingTombstone.reconciliation,
    });
    await dependencies.store.releaseTerminal(journal.proposalId, journal.ownerNonce, existingTombstone.auditEventId);
    return true;
  }

  let reconciliation = finalReconciliation(journal);
  let session: TerminalRecoverySession | null = null;
  if (!reconciliation) {
    reconciliation = outcome === "noCredit" ? "availability-changed-unreconciled" : "unreconciled";
    try {
      const qualification = await dependencies.qualifier.qualify(dependencies.codexBin);
      if (qualification.status === "qualified" && await dependencies.qualifier.matchesIdentity(qualification.identity)) {
        let invalidated = false;
        session = await dependencies.startSession({
          codexBin: qualification.identity.canonicalPath,
          onNotification: (notification) => {
            if (notification.method === "account/updated") invalidated = true;
          },
          onUnexpectedProcessClose: () => {
            invalidated = true;
          },
        });
        const gateway = dependencies.gatewayForSession(session);
        const accountRead = await gateway.readAccount();
        const account = accountRead.account;
        if (!invalidated && !accountRead.requiresOpenAiAuth && account?.type === "chatgpt" && account.email && account.plan !== "unknown") {
          const evidence = await dependencies.store.verifyRecoveryEvidence(journal, {
            accountCheck: { email: account.email, plan: account.plan },
            runtimeIdentity: qualification.identity,
          });
          if (evidence.accountMatches && evidence.runtimeMatches) {
            await gateway.readRateLimits();
            if (!invalidated) reconciliation = "reconciled";
          }
        }
      }
    } catch {
      // Provider outcome is already terminal; failed read-only recovery becomes unreconciled.
    } finally {
      await session?.close().catch(() => {});
    }
    journal = await dependencies.store.transitionJournal(journal.proposalId, journal.ownerNonce, "terminal", {
      ...journal,
      reconciliation,
      updatedAt: dependencies.now().toISOString(),
    });
  }
  const createdAt = dependencies.now().toISOString();
  const tombstone: TerminalRedemptionTombstone = {
    schemaVersion: 1,
    proposalId: journal.proposalId,
    selectionMode: journal.selection.mode,
    outcome,
    reconciliation,
    auditEventId,
    message: terminalMessage(outcome, journal.selection.mode, reconciliation),
    createdAt,
    expiresAt: new Date(dependencies.now().getTime() + 600_000).toISOString(),
  };
  await dependencies.store.publishTombstone(tombstone);
  await dependencies.auditSink({
    eventId: tombstone.auditEventId,
    event: "codex_redemption_terminal",
    timestamp: tombstone.createdAt,
    outcome: tombstone.outcome,
    codexVersion: journal.runtimeIdentity.version,
    selectionMode: tombstone.selectionMode,
    reconciliation: tombstone.reconciliation,
  });
  await dependencies.store.releaseTerminal(journal.proposalId, journal.ownerNonce, tombstone.auditEventId);
  return true;
}
