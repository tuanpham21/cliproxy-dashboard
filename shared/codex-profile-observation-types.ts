import type { CodexAccountUsageWindow } from "./types.js";

export type CodexProfileObservationFreshness = "fresh" | "latest-known" | "identity-changed";
export type CodexProfileObservationSnapshot = Readonly<{
  account: { email: string; plan: string };
  observedAt: string;
  usage: { primary: CodexAccountUsageWindow | null; secondary: CodexAccountUsageWindow | null };
  resetCredits: { availableCount: number | null };
  runtimeVersion: string;
  freshness: CodexProfileObservationFreshness;
}>;

export type CodexProfileRowStatus =
  | "pending"
  | "identity-changed"
  | "disabled"
  | "fresh"
  | "latest-known"
  | "never-observed";

export type CodexProfileObservationRowView = {
  profileId: string;
  label: string;
  enabled: boolean;
  order: number;
  status: CodexProfileRowStatus;
  observation: CodexProfileObservationSnapshot | null;
};

export type CodexProfileObservationSummaryView = {
  total: number;
  pending: number;
  fresh: number;
  latestKnown: number;
  disabled: number;
  identityChanged: number;
  neverObserved: number;
  profilesWithResets: number;
};

export type CodexProfileObservationListView = {
  profiles: CodexProfileObservationRowView[];
  summary: CodexProfileObservationSummaryView;
};

export function summarizeCodexProfileObservations(
  profiles: readonly CodexProfileObservationRowView[],
): CodexProfileObservationSummaryView {
  const summary: CodexProfileObservationSummaryView = {
    total: profiles.length,
    pending: 0,
    fresh: 0,
    latestKnown: 0,
    disabled: 0,
    identityChanged: 0,
    neverObserved: 0,
    profilesWithResets: 0,
  };
  for (const profile of profiles) {
    if (profile.status === "latest-known") summary.latestKnown += 1;
    else if (profile.status === "identity-changed") summary.identityChanged += 1;
    else if (profile.status === "never-observed") summary.neverObserved += 1;
    else summary[profile.status] += 1;
    if (profile.status !== "identity-changed" &&
      (profile.observation?.resetCredits.availableCount ?? 0) > 0) {
      summary.profilesWithResets += 1;
    }
  }
  return summary;
}

export type UpdateCodexProfileMetadataInput = { label?: string; enabled?: boolean };
export type ReorderCodexProfilesInput = { profileIds: string[] };
