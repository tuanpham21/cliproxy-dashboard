import type { CodexAccountUsageWindow } from "./types.js";

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
      allowedAction: "cancel";
      createdAt: string;
      expiresAt: string;
      selectionMode: "specific" | "generic";
    }
  | { status: "not-found" }
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
