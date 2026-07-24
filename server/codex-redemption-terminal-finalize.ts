import type {
  CodexRedemptionCurrentView,
  CodexRedemptionUsageSnapshot,
} from "../shared/codex-account-types.js";
import type {
  CodexConsumeResetCreditOutcome,
  CodexRateLimitsRead,
} from "./codex-account-gateway.js";
import type { CodexRedemptionAuditSink } from "./codex-redemption-audit.js";
import { newRedemptionAuditEventId } from "./codex-redemption-audit.js";
import { CodexRedemptionConsumeError } from "./codex-redemption-consume-error.js";
import {
  parseRedemptionJournal,
  type RedemptionJournal,
  type RedemptionJournalPatch,
  type RedemptionReconciliation,
  type TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";
import { terminalMessage } from "./codex-redemption-terminal-message.js";
export { terminalMessage } from "./codex-redemption-terminal-message.js";

type TerminalStore = {
  transitionJournal(
    proposalId: string,
    ownerNonce: string,
    expectedPhase: RedemptionJournal["phase"],
    next: RedemptionJournal,
  ): Promise<RedemptionJournal>;
  publishTombstone(tombstone: TerminalRedemptionTombstone): Promise<void>;
  releaseTerminal(proposalId: string, ownerNonce: string, auditEventId: string): Promise<void>;
};

export type TerminalFinalizeDependencies = {
  active: {
    journal: RedemptionJournal;
    session: { close(): Promise<void> };
    invalidated: boolean;
  };
  gateway: { readRateLimits(): Promise<CodexRateLimitsRead> };
  store: TerminalStore;
  now: () => Date;
    auditSink: CodexRedemptionAuditSink;
    codexVersion: string;
    account: { email: string; plan: string };
  outcome: CodexConsumeResetCreditOutcome;
  expectedPhase: "dispatched" | "ambiguous";
  initialRateLimits?: CodexRateLimitsRead;
};

function secondsToIso(value: number | null): string | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function usageSnapshot(
  read: CodexRateLimitsRead,
  observedAt: string,
  account: { email: string; plan: string },
  runtimeVersion: string,
): CodexRedemptionUsageSnapshot {
  const window = (value: CodexRateLimitsRead["rateLimits"]["primary"]) => value ? {
    usedPercent: Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100 ? value.usedPercent : null,
    durationMinutes: value.windowMinutes !== null && value.windowMinutes >= 0 ? value.windowMinutes : null,
    resetsAt: secondsToIso(value.resetsAt),
  } : null;
  const sourceCredits = read.resetCredits?.credits ?? [];
  const credits = sourceCredits.map((credit) => ({
    availability: credit.availability,
    title: credit.title,
    description: credit.description,
    grantedAt: secondsToIso(credit.grantedAt),
    expiresAt: secondsToIso(credit.expiresAt),
  }));
  const availableCount = read.resetCredits?.availableCount ?? 0;
    return {
      account,
      runtimeVersion,
      observedAt,
    usage: { primary: window(read.rateLimits.primary), secondary: window(read.rateLimits.secondary) },
    resetCredits: {
      availableCount,
      selectionMode: availableCount <= 0
        ? "none"
          : sourceCredits.some((credit) => credit.availability === "available" && Boolean(credit.id))
          ? "detailed"
          : "generic",
      credits,
    },
  };
}

export function publicTerminal(
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

function nextJournal(active: RedemptionJournal, patch: RedemptionJournalPatch): RedemptionJournal {
  const parsed = parseRedemptionJournal({ ...active, ...patch });
  if (!parsed) throw new CodexRedemptionConsumeError("redemption-recovery-required");
  return parsed;
}

export async function finalizeRedemptionOutcome(
  dependencies: TerminalFinalizeDependencies,
): Promise<CodexRedemptionCurrentView> {
  const { active, gateway, store, now, outcome } = dependencies;
  const auditEventId = newRedemptionAuditEventId();
  const initialReconciliation: RedemptionReconciliation = outcome === "nothingToReset" ? "not-required" : "pending";
  active.journal = await store.transitionJournal(
    active.journal.proposalId,
    active.journal.ownerNonce,
    dependencies.expectedPhase,
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
  let reconciledRead: CodexRateLimitsRead | null = outcome === "nothingToReset"
    ? dependencies.initialRateLimits ?? null
    : null;
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
  const createdAt = now().toISOString();
  const tombstone: TerminalRedemptionTombstone = {
    schemaVersion: 1,
    proposalId: active.journal.proposalId,
    selectionMode: active.journal.selection.mode,
    outcome,
    reconciliation: reconciliation as Exclude<RedemptionReconciliation, "pending">,
    auditEventId,
    message: terminalMessage(outcome, active.journal.selection.mode, reconciliation),
    createdAt,
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
  await store.releaseTerminal(active.journal.proposalId, active.journal.ownerNonce, auditEventId);
  await active.session.close();
    return publicTerminal(tombstone, reconciledRead
      ? usageSnapshot(reconciledRead, tombstone.createdAt, dependencies.account, dependencies.codexVersion)
      : undefined);
  }
