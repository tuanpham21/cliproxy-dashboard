import type {
  RedemptionJournal,
  RedemptionSelection,
  TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";

export type PublicPrivateRedemptionState =
  | { status: "not-found" }
  | {
      status: "prepared";
      proposalId: string;
      selectionMode: RedemptionSelection["mode"];
      createdAt: string;
      expiresAt: string;
    }
  | {
      status: "recovery-required";
      code: "redemption-recovery-required";
      message: "Reset redemption recovery state requires local repair.";
    }
  | {
      status: "unavailable";
      code: "redemption-private-state-unavailable";
      message: "Private reset redemption state is unavailable on this host.";
    }
  | {
      status: "ambiguous";
      proposalId: string;
      selectionMode: RedemptionSelection["mode"];
      dispatchAt: string;
    }
  | {
      status: "processing";
      proposalId: string;
      selectionMode: RedemptionSelection["mode"];
      phase: "dispatch-intent" | "dispatched" | "terminal";
      dispatchAt: string;
    }
  | { status: "terminal"; tombstone: TerminalRedemptionTombstone };

export function publicStateFromJournal(
  journal: RedemptionJournal,
  tombstone: TerminalRedemptionTombstone | null,
): PublicPrivateRedemptionState {
  if (journal.phase === "prepared") {
    return {
      status: "prepared",
      proposalId: journal.proposalId,
      selectionMode: journal.selection.mode,
      createdAt: journal.createdAt,
      expiresAt: journal.expiresAt,
    };
  }
  if (journal.phase === "terminal" && tombstone) return { status: "terminal", tombstone };
  if (journal.phase === "ambiguous" && journal.dispatchAt) {
    return {
      status: "ambiguous",
      proposalId: journal.proposalId,
      selectionMode: journal.selection.mode,
      dispatchAt: journal.dispatchAt,
    };
  }
  if (journal.dispatchAt && (journal.phase === "dispatch-intent" || journal.phase === "dispatched" || journal.phase === "terminal")) {
    return {
      status: "processing",
      proposalId: journal.proposalId,
      selectionMode: journal.selection.mode,
      phase: journal.phase,
      dispatchAt: journal.dispatchAt,
    };
  }
  return {
    status: "recovery-required",
    code: "redemption-recovery-required",
    message: "Reset redemption recovery state requires local repair.",
  };
}
