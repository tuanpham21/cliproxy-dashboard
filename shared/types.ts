export type QuotaWindowName = "primary5h" | "weekly";
export type QuotaEvidenceSource = "response-header" | "identity-bound-read";
export type PublicQuotaStatus = "unknown" | "current" | "stale" | "refresh-needed" | "blocked";

export type PublicQuotaWindow = {
  status: PublicQuotaStatus;
  usedPercent?: number;
  rawUsedPercent?: number;
  resetAt?: string;
  observedAt?: string;
  source?: QuotaEvidenceSource;
  durationMinutes?: number;
  windowKind?: "weekly" | "five-hour" | "unknown";
  providerSlot?: string;
  continuity?: "continuous" | "broken" | "uncertain";
  migrationOnly?: boolean;
  identityBound?: boolean;
};

export type PublicQuotaSnapshot = Record<QuotaWindowName, PublicQuotaWindow>;

export type PublicDashboardPaths = {
  configPath: string;
  authDir: string;
  backupRoot: string;
  logsDir: string;
  mainLogPath: string;
  quotaSnapshotStatePath: string;
  proxyUrl: string;
  proxyPort: number;
  inboundKeyConfigured: boolean;
};

export type PublicProxyConfig = {
  path: string;
  port: number;
  authDir: string;
  routingStrategy: string;
  sessionAffinity: boolean;
  apiKeysConfigured: boolean;
  apiKeyCount: number;
};

export type PublicAccountView = {
  proxyAccountKey?: string;
  fileName: string;
  path: string;
  email: string;
  priority: number;
  explicitPriority: boolean;
  disabled: boolean;
  note: string;
  accountId: string;
  accountIdShort: string;
  type: string;
  plan: string;
  expired: string;
  lastRefresh: string;
  validityStatus?: "valid" | "invalid" | "unverified";
  validationError?: string;
  subscriptionPlan?: string;
  subscriptionActiveUntil?: string;
  subscriptionLastChecked?: string;
  quota: PublicQuotaSnapshot;
};

export type ProxyModelView = {
  id: string;
  created: number;
  ownedBy: string;
};

export type SelectorLogLine = {
  timestamp: string;
  traceId: string;
  level: string;
  source: string;
  session: string;
  auth: string;
  provider: string;
  model: string;
  raw: string;
};

export type CodexSelectionLogLine = {
  timestamp: string;
  auth: string;
  provider: string;
  raw: string;
  fileName: string;
  label: string;
  type: string;
};

export type RequestLogLine = {
  timestamp: string;
  traceId: string;
  level: string;
  source: string;
  status: number;
  duration: string;
  client: string;
  method: string;
  path: string;
  raw: string;
};

export type LogSummary = {
  latestSelection: SelectorLogLine | null;
  latestCodexSelection: CodexSelectionLogLine | null;
  recentSelections: SelectorLogLine[];
  latestRequest: RequestLogLine | null;
  recentRequests: RequestLogLine[];
};

export type PublicRotationState = {
  mode: "off" | "shadow" | "active";
  lifecycle: "off" | "recovering" | "shadow" | "active" | "pending" | "awaiting-confirmation" | "manual-hold" | "paused" | "recovery-required";
  minimumQuotaSpread: number;
  pool: Array<{ proxyAccountKey: string; fileName: string; exclusivityAttested: boolean; addedAt: string }>;
  routingTargetKey?: string;
  observedRoutedAccountKey?: string;
  evidenceWatermark?: string;
  lastDecision?: { kind: "switch" | "hold" | "pause" | "confirm"; reason: string; targetKey?: string; spread?: number; pauseReason?: string };
  eligibleCount: number;
    provisionalCount: number;
    provisionalResetAttempt?: { proxyAccountKey: string; resetAt: string; evidenceWatermark: string };
    quotaSpread?: number;
  journal: { phase: "idle" | "journaled" | "mutating" | "mutated" | "verified" | "committed" | "restoring"; routingTargetKey?: string; intendedPriority?: number };
  pauseReason?: string;
  pauseMessage?: string;
  manualHold: boolean;
  restorationVerified: boolean;
  canActivate: boolean;
  routingCompatible: boolean;
  routingCompatibilityMessage?: string;
  audit: Array<{ id: string; at: string; kind: string; message: string; proxyAccountKey?: string; observationId?: string; pauseReason?: string }>;
};

export type DashboardState = {
  paths: PublicDashboardPaths;
  config: PublicProxyConfig | null;
  accounts: PublicAccountView[];
  selectedAccount: PublicAccountView | null;
  models: ProxyModelView[];
  logSummary: LogSummary;
  rotation?: PublicRotationState;
  errors: string[];
  lastRefreshedAt: string;
};

export type RateLimitState = {
  ok: boolean;
  availableCount: number;
  error?: string;
  authRequired?: boolean;
};
