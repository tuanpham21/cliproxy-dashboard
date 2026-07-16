import type { CodexRedemptionAuditSink } from "./codex-redemption-audit.js";
import { CodexRedemptionConsumeError } from "./codex-redemption-consume.js";
import type {
  RedemptionJournal,
  TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";

export type TerminalReplayDependencies = {
  journal: RedemptionJournal;
  tombstone: TerminalRedemptionTombstone;
  auditSink: CodexRedemptionAuditSink;
  codexVersion: string;
  session: { close(): Promise<void> };
  store: {
    readJournal(proposalId: string, ownerNonce: string): Promise<RedemptionJournal | null>;
    releaseTerminal(proposalId: string, ownerNonce: string, auditEventId: string): Promise<void>;
  };
};

export async function finishTerminalReplay(dependencies: TerminalReplayDependencies): Promise<void> {
  const { journal, tombstone } = dependencies;
  if (journal.phase !== "terminal" || journal.auditEventId !== tombstone.auditEventId) {
    throw new CodexRedemptionConsumeError("redemption-recovery-required");
  }
  const authoritative = await dependencies.store.readJournal(journal.proposalId, journal.ownerNonce);
  if (authoritative) {
    if (
      authoritative.phase !== "terminal" ||
      authoritative.auditEventId !== tombstone.auditEventId ||
      authoritative.outcome !== tombstone.outcome ||
      authoritative.reconciliation !== tombstone.reconciliation ||
      authoritative.selection.mode !== tombstone.selectionMode
    ) throw new CodexRedemptionConsumeError("redemption-recovery-required");
    await dependencies.auditSink({
      eventId: tombstone.auditEventId,
      event: "codex_redemption_terminal",
      timestamp: tombstone.createdAt,
      outcome: tombstone.outcome,
      codexVersion: dependencies.codexVersion,
      selectionMode: tombstone.selectionMode,
      reconciliation: tombstone.reconciliation,
    });
    await dependencies.store.releaseTerminal(journal.proposalId, journal.ownerNonce, tombstone.auditEventId);
  }
  await dependencies.session.close();
}
