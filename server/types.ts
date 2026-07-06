import type {
  CodexSelectionLogLine,
  DashboardState,
  LogSummary,
  ProxyModelView,
  PublicAccountView,
  PublicDashboardPaths,
  PublicProxyConfig,
  PublicQuotaSnapshot,
  PublicQuotaStatus,
  PublicQuotaWindow,
  QuotaEvidenceSource,
  QuotaWindowName,
  RequestLogLine,
  SelectorLogLine,
} from "../shared/types.js";

export type {
  CodexSelectionLogLine,
  DashboardState,
  LogSummary,
  ProxyModelView,
  PublicAccountView,
  PublicDashboardPaths,
  PublicProxyConfig,
  PublicQuotaSnapshot,
  PublicQuotaStatus,
  PublicQuotaWindow,
  QuotaEvidenceSource,
  QuotaWindowName,
  RateLimitState,
  RequestLogLine,
  SelectorLogLine,
} from "../shared/types.js";

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

export type ProxyConfig = {
  raw: Record<string, unknown>;
  path: string;
  port: number;
  authDir: string;
  routingStrategy: string;
  sessionAffinity: boolean;
  apiKeys: string[];
};

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
