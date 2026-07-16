export const ROTATION_MODES = ["off", "shadow", "active"] as const;
export type RotationMode = (typeof ROTATION_MODES)[number];

export const ROTATION_LIFECYCLES = [
  "off",
  "recovering",
  "shadow",
  "active",
  "pending",
  "awaiting-confirmation",
  "manual-hold",
  "paused",
  "recovery-required",
] as const;
export type RotationLifecycle = (typeof ROTATION_LIFECYCLES)[number];

export const ROTATION_PAUSE_REASONS = [
  "no-eligible-members",
  "routing-incompatible",
  "observation-uncertain",
  "identity-mismatch",
  "mutation-failed",
  "mutation-verification-failed",
  "selection-mismatch",
  "switch-budget-exhausted",
  "external-priority-edit",
  "corrupt-state",
  "insufficient-priority-headroom",
  "provisional-confirmation-failed",
  "recovery-unverifiable",
] as const;
export type RotationPauseReason = (typeof ROTATION_PAUSE_REASONS)[number];

export const ROTATION_JOURNAL_PHASES = ["idle", "journaled", "mutating", "mutated", "verified", "committed", "restoring"] as const;
export type RotationJournalPhase = (typeof ROTATION_JOURNAL_PHASES)[number];

export type QuotaWindowKind = "weekly" | "five-hour" | "unknown";
export type ObservationContinuity = "continuous" | "broken" | "uncertain";

export type SemanticQuotaEvidence = {
  usedPercent: number;
  rawUsedPercent?: number;
  resetAt?: string;
  observedAt: string;
  durationMinutes?: number;
  windowKind: QuotaWindowKind;
  providerSlot?: "primary" | "secondary" | string;
  evidenceId: string;
  credentialFingerprint: string;
  continuity: ObservationContinuity;
  migrationOnly?: boolean;
  schemaVersion: number;
};

export type RotationAccountSnapshot = {
  proxyAccountKey: string;
  fileName: string;
  enabled: boolean;
  sessionValid: boolean;
  observable: boolean;
  observationContinuity: ObservationContinuity;
  rotationPoolMember: boolean;
  exclusivityAttested: boolean;
  identityFingerprint: string;
  identityVerified: boolean;
  weekly?: SemanticQuotaEvidence;
  exhausted: boolean;
  cooldownUntil?: string;
  provisionalReset?: boolean;
  lastSelectedAt?: number;
  priority?: number;
  explicitPriority?: boolean;
};

export type RotationDecisionInput = {
  accounts: RotationAccountSnapshot[];
  routingTargetKey?: string;
  nowMs: number;
  recentAutomaticSwitches: number[];
  observationId: string;
  observationAt: string;
  mode: RotationMode;
  seenObservationIds?: string[];
  evidenceWatermark?: string;
};

export type RotationDecision = {
  kind: "switch" | "hold" | "pause" | "confirm";
  reason: string;
  targetKey?: string;
  activeUsedPercent?: number;
  lowestUsedPercent?: number;
  spread?: number;
  pauseReason?: RotationPauseReason;
};

export type RotationPoolMember = {
  proxyAccountKey: string;
  fileName: string;
  exclusivityAttested: boolean;
  addedAt: string;
};

export type RotationAuditEvent = {
  id: string;
  at: string;
  kind: "decision" | "switch" | "pause" | "hold" | "resume" | "restore" | "observation";
  message: string;
  proxyAccountKey?: string;
  observationId?: string;
  pauseReason?: RotationPauseReason;
};

export type RotationJournal = {
  phase: RotationJournalPhase;
  observationId?: string;
  fromProxyAccountKey?: string;
  routingTargetKey?: string;
  targetFingerprint?: string;
  targetRevision?: string;
  evidenceWatermark?: string;
  intendedPriority?: number;
  basePriorities?: RotationPrioritySnapshots;
  previousPriorities?: RotationPrioritySnapshots;
  restoreIntent?: "rollback" | "disable";
  updatedAt?: string;
};

export type RotationPrioritySnapshot = {
  fileName: string;
  present: boolean;
  value?: number;
  fingerprint: string;
  disabled: boolean;
  note: string;
};

export type RotationPrioritySnapshots = Record<string, RotationPrioritySnapshot>;

export type RotationOverlayState = {
  basePriorities: RotationPrioritySnapshots;
  appliedPriorities: Record<string, number>;
};

export type RotationState = {
  schemaVersion: 1;
  mode: RotationMode;
  lifecycle: RotationLifecycle;
  pool: RotationPoolMember[];
  routingTargetKey?: string;
  observedRoutedAccountKey?: string;
  lastObservationId?: string;
  evidenceWatermark?: string;
  switchTimestamps: number[];
  journal: RotationJournal;
  overlay?: RotationOverlayState;
  pauseReason?: RotationPauseReason;
  pauseMessage?: string;
  manualHold: boolean;
  restorationVerified: boolean;
  audit: RotationAuditEvent[];
};

export type RotationPriorityWriter = {
  readAccounts(): Promise<Array<{ proxyAccountKey: string; fileName: string; priority: number; explicitPriority: boolean; revision: string; fingerprint: string; disabled: boolean; note: string }>>;
  setTargetPriority(input: { fileName: string; proxyAccountKey: string; priority: number; expectedRevision: string; expectedFingerprint: string }): Promise<{ priority: number; explicitPriority: true; revision: string; fingerprint: string }>;
  restoreBasePriorities(input: Record<string, { fileName: string; proxyAccountKey: string; present: boolean; value?: number; expectedRevision: string; expectedFingerprint: string }>): Promise<void>;
};

export type RotationControllerOptions = {
  statePath: string;
  mode?: RotationMode;
  writer?: RotationPriorityWriter;
  routingStrategy?: string;
  sessionAffinity?: boolean;
  responseLoggingHealthy?: boolean;
  now?: () => number;
  crashInjector?: (phase: RotationJournal["phase"]) => Promise<void> | void;
};
