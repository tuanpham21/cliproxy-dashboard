export type CodexProfileRefreshSource = "startup" | "scheduled" | "manual";
export type CodexProfileRefreshRunOutcome = "idle" | "running" | "completed" | "partial" | "cancelled";
export type CodexProfileRefreshEntryStatus = "pending" | "refreshing" | "refreshed" | "failed" | "skipped" | "cancelled";
export type CodexProfileRefreshEntryReason =
  | "disabled"
  | "re-login-required"
  | "identity-changed"
  | "not-refreshable"
  | "read-failed"
  | "cancelled";

export type CodexProfileRefreshEntryView = {
  profileId: string;
  label: string;
  status: CodexProfileRefreshEntryStatus;
  attempts: number;
  reason?: CodexProfileRefreshEntryReason;
};

export type CodexProfileRefreshRunView = {
  source: CodexProfileRefreshSource | null;
  outcome: CodexProfileRefreshRunOutcome;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  completed: number;
  currentProfileId: string | null;
  profiles: CodexProfileRefreshEntryView[];
};
