export type QuotaWindowName = "primary5h" | "weekly";
export type QuotaEvidenceSource = "response-header" | "identity-bound-read";
export type PublicQuotaStatus = "unknown" | "current" | "stale" | "refresh-needed" | "blocked";

export type PublicQuotaWindow = {
  status: PublicQuotaStatus;
  usedPercent?: number;
  resetAt?: string;
  observedAt?: string;
  source?: QuotaEvidenceSource;
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

export type DashboardState = {
  paths: PublicDashboardPaths;
  config: PublicProxyConfig | null;
  accounts: PublicAccountView[];
  selectedAccount: PublicAccountView | null;
  models: ProxyModelView[];
  logSummary: LogSummary;
  errors: string[];
  lastRefreshedAt: string;
};

export type RateLimitState = {
  ok: boolean;
  availableCount: number;
  error?: string;
  authRequired?: boolean;
};
