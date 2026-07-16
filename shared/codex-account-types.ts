import type { CodexAccountResetCredit, CodexAccountUsageWindow } from "./types.js";

export type CodexRedemptionUsageSnapshot = {
  observedAt: string;
  usage: { primary: CodexAccountUsageWindow | null; secondary: CodexAccountUsageWindow | null };
  resetCredits: {
    availableCount: number;
    selectionMode: "none" | "detailed" | "generic";
    credits: CodexAccountResetCredit[];
  };
};

export type CodexRedemptionProposalSelection =
  | {
      mode: "specific";
      title: string;
      description: string | null;
      expiresAt: string | null;
    }
  | { mode: "generic" };

export type CodexRedemptionProposalView = {
  status: "prepared";
  proposalId: string;
  allowedAction: "cancel";
  createdAt: string;
  expiresAt: string;
  account: { email: string; plan: string };
  usage: { primary: CodexAccountUsageWindow | null; secondary: CodexAccountUsageWindow | null };
  availableCount: number;
  selection: CodexRedemptionProposalSelection;
};

export type CodexRedemptionStateView =
  | {
      status: "prepared";
      proposalId: string;
      allowedAction: "cancel" | "poll";
      createdAt: string;
      expiresAt: string;
      selectionMode: "specific" | "generic";
    }
  | { status: "not-found" }
  | {
      status: "ambiguous";
      proposalId: string;
      allowedAction: "retry-same";
      selectionMode: "specific" | "generic";
      dispatchAt: string;
    }
  | {
      status: "processing";
      proposalId: string;
      allowedAction: "poll";
      selectionMode: "specific" | "generic";
        phase: "dispatch-intent" | "dispatched" | "retrying" | "terminal";
      dispatchAt: string;
    }
  | {
      status: "terminal";
      proposalId: string;
      allowedAction: "none";
      selectionMode: "specific" | "generic";
      outcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
      reconciliation: "reconciled" | "unreconciled" | "availability-changed-unreconciled" | "not-required";
      message: string;
      auditEventId: string;
      createdAt: string;
      expiresAt: string;
      accountUsage?: CodexRedemptionUsageSnapshot;
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
    };

export type CodexRedemptionCurrentView = CodexRedemptionProposalView | CodexRedemptionStateView;

export type PrepareCodexRedemptionInput = {
  creditId?: string;
  singleWorkspaceAttested: true;
};
