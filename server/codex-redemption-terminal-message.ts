import type { CodexConsumeResetCreditOutcome } from "./codex-account-gateway.js";
import type { RedemptionReconciliation } from "./codex-redemption-journal.js";

export function terminalMessage(
  outcome: CodexConsumeResetCreditOutcome,
  selectionMode: "specific" | "generic",
  reconciliation: RedemptionReconciliation,
): string {
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
