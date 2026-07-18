import type { CodexAccountUsageWindow } from "./types.js";

export type CodexProfileLoginStartedView = {
  profileId: string;
  status: "login-in-progress";
};

export type CodexProfileCandidateView = {
  profileId: string;
  status: "awaiting-confirmation";
  account: { email: string; plan: string };
  observedAt: string;
  usage: { primary: CodexAccountUsageWindow | null; secondary: CodexAccountUsageWindow | null };
  resetCredits: { availableCount: number | null };
};

export type CodexProfileConfirmedView = Omit<CodexProfileCandidateView, "status"> & {
  status: "confirmed";
};

export type CodexProfileCancelledView = {
  profileId: string;
  status: "cancelled";
};

export type ConfirmCodexProfileInput = {
  confirmed: true;
  email: string;
  plan: string;
};

export type CodexProfileOnboardingView =
  | CodexProfileLoginStartedView
  | CodexProfileCandidateView
  | CodexProfileConfirmedView
  | CodexProfileCancelledView;
