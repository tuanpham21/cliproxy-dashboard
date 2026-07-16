import type { CodexRedemptionStateView } from "../shared/codex-account-types.js";
import type { PublicPrivateRedemptionState } from "./codex-redemption-public-state.js";

export function publicRedemptionView(state: PublicPrivateRedemptionState): CodexRedemptionStateView {
  if (state.status === "ambiguous") {
    return {
      status: "ambiguous",
      proposalId: state.proposalId,
      allowedAction: "retry-same",
      selectionMode: state.selectionMode,
      dispatchAt: state.dispatchAt,
    };
  }
  if (state.status === "processing") {
    return {
      status: "processing",
      proposalId: state.proposalId,
      allowedAction: "poll",
      selectionMode: state.selectionMode,
      phase: state.phase,
      dispatchAt: state.dispatchAt,
    };
  }
  if (state.status === "terminal") {
    return {
      status: "terminal",
      proposalId: state.tombstone.proposalId,
      allowedAction: "none",
      selectionMode: state.tombstone.selectionMode,
      outcome: state.tombstone.outcome,
      reconciliation: state.tombstone.reconciliation,
      message: state.tombstone.message,
      auditEventId: state.tombstone.auditEventId,
      createdAt: state.tombstone.createdAt,
      expiresAt: state.tombstone.expiresAt,
    };
  }
  if (state.status !== "prepared") return state;
  return {
    status: "prepared",
    proposalId: state.proposalId,
    allowedAction: "poll",
    createdAt: state.createdAt,
    expiresAt: state.expiresAt,
    selectionMode: state.selectionMode,
  };
}
