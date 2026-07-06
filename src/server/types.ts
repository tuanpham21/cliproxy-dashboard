export type DashboardPaths = {
  configPath: string;
  authDir: string;
  backupRoot: string;
  logsDir: string;
  mainLogPath: string;
  quotaSnapshotStatePath: string;
  proxyUrl: string;
  proxyPort: number;
  inboundKey: string | null;
};

export type PublicDashboardPaths = Omit<DashboardPaths, "inboundKey"> & {
  inboundKeyConfigured: boolean;
};

export type ProxyConfig = {
  raw: Record<string, unknown>;
  path: string;
  port: number;
  authDir: string;
  routingStrategy: string;
  sessionAffinity: boolean;
  apiKeys: string[];
};

export type PublicProxyConfig = Omit<ProxyConfig, "raw" | "apiKeys"> & {
  apiKeysConfigured: boolean;
  apiKeyCount: number;
};

export type QuotaWindowName = "primary5h" | "weekly";
export type QuotaEvidenceSource = "response-header" | "identity-bound-read";
export type PublicQuotaStatus = "unknown" | "current" | "stale" | "refresh-needed" | "blocked";

export type PersistedQuotaWindowEvidence = {
  usedPercent?: number;
  resetAt?: string;
  observedAt: string;
  source: QuotaEvidenceSource;
  debugStatus?: string;
};

export type PersistedQuotaSnapshot = {
  proxyAccountKey: string;
  primary5h?: PersistedQuotaWindowEvidence;
  weekly?: PersistedQuotaWindowEvidence;
};

export type PersistedQuotaSnapshotStore = {
  schemaVersion: number;
  keyDerivation: {
    algorithm: "hmac-sha256";
    secret: string;
    keyPrefix: "pak_v1";
  };
  snapshots: PersistedQuotaSnapshot[];
};

export type PublicQuotaWindow = {
  status: PublicQuotaStatus;
  usedPercent?: number;
  resetAt?: string;
  observedAt?: string;
  source?: QuotaEvidenceSource;
};

export type PublicQuotaSnapshot = Record<QuotaWindowName, PublicQuotaWindow>;

export type AccountView = {
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
  raw: Record<string, unknown>;
};

export type PublicAccountView = Omit<AccountView, "raw"> & {
  quota: PublicQuotaSnapshot;
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

export type ProxyModelView = {
  id: string;
  created: number;
  ownedBy: string;
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

export type DashboardOptions = {
  configPath?: string;
  authDir?: string;
  backupRoot?: string;
  mainLogPath?: string;
  quotaSnapshotStatePath?: string;
  proxyPort?: number;
  proxyUrl?: string;
  inboundKey?: string | null;
  host?: string;
  cliProxyBin?: string;
  codexBin?: string;
  operatorToken?: string;
  allowPortFallback?: boolean;
  beforeQuotaSnapshotStateWrite?: () => Promise<void> | void;
};

export type TestRequestOptions = {
  model?: string;
  prompt?: string;
  maxOutputTokens?: number;
};

export type QuotaSnapshotUpdate = {
  canonicalLocalIdentity: string;
  primary5h?: PersistedQuotaWindowEvidence;
  weekly?: PersistedQuotaWindowEvidence;
};
