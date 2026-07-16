export type RotationMode = "off" | "shadow" | "active";

export type RotationLifecycle =
  | "off"
  | "recovering"
  | "shadow"
  | "active"
  | "pending"
  | "awaiting-confirmation"
  | "manual-hold"
  | "paused"
  | "recovery-required";

export type RotationPauseReason =
  | "no-eligible-members"
  | "routing-incompatible"
  | "observation-uncertain"
  | "identity-mismatch"
  | "mutation-failed"
  | "mutation-verification-failed"
  | "selection-mismatch"
  | "switch-budget-exhausted"
  | "external-priority-edit"
  | "corrupt-state"
  | "insufficient-priority-headroom"
  | "provisional-confirmation-failed"
  | "recovery-unverifiable";

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
  phase: "idle" | "journaled" | "mutating" | "mutated" | "verified" | "restoring";
  observationId?: string;
  fromKey?: string;
  targetKey?: string;
  targetFingerprint?: string;
  intendedPriority?: number;
  basePriorities?: Record<string, { present: boolean; value?: number; fingerprint: string }>;
  updatedAt?: string;
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
};
