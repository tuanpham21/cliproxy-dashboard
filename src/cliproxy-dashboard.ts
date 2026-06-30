import { spawn } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
  copyFile,
  rename,
  unlink,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_DASHBOARD_PORT = 60948;
const DEFAULT_PROXY_PORT = 8317;
const DEFAULT_PRIORITY = 100;
const DEFAULT_BACKUP_PRIORITY = 10;
const DEFAULT_TEST_MODEL = "gpt-5.4-mini";
const DEFAULT_TEST_PROMPT = "cliproxy dashboard test request";
const DEFAULT_TEST_OUTPUT_TOKENS = 1;
const DEFAULT_LOG_BYTES = 512_000;

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config/cli-proxy-api/config.yaml");
const DEFAULT_AUTH_DIR = path.join(os.homedir(), ".cli-proxy-api");
const DEFAULT_BACKUP_ROOT = path.join(os.homedir(), ".cli-proxy-api-backups", "cliproxy-dashboard");
const WINDOWS_CLI_PROXY_BIN = "C:\\Tools\\cli-proxy-api\\cli-proxy-api.exe";
const DASHBOARD_STATE_DIR_NAME = "cliproxy-dashboard";
const QUOTA_SNAPSHOT_STATE_FILE_NAME = "quota-snapshots.json";
const QUOTA_SNAPSHOT_SCHEMA_VERSION = 1;
const DASHBOARD_OPERATOR_TOKEN_HEADER = "x-cliproxy-dashboard-token";

type DashboardPaths = {
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

type PublicDashboardPaths = Omit<DashboardPaths, "inboundKey"> & {
  inboundKeyConfigured: boolean;
};

type ProxyConfig = {
  raw: Record<string, unknown>;
  path: string;
  port: number;
  authDir: string;
  routingStrategy: string;
  sessionAffinity: boolean;
  apiKeys: string[];
};

type PublicProxyConfig = Omit<ProxyConfig, "raw" | "apiKeys"> & {
  apiKeysConfigured: boolean;
  apiKeyCount: number;
};

type QuotaWindowName = "primary5h" | "weekly";
type QuotaEvidenceSource = "response-header" | "identity-bound-read";
type PublicQuotaStatus = "unknown" | "current" | "stale" | "refresh-needed" | "blocked";

type PersistedQuotaWindowEvidence = {
  usedPercent?: number;
  resetAt?: string;
  observedAt: string;
  source: QuotaEvidenceSource;
  debugStatus?: string;
};

type PersistedQuotaSnapshot = {
  proxyAccountKey: string;
  primary5h?: PersistedQuotaWindowEvidence;
  weekly?: PersistedQuotaWindowEvidence;
};

type PersistedQuotaSnapshotStore = {
  schemaVersion: typeof QUOTA_SNAPSHOT_SCHEMA_VERSION;
  keyDerivation: {
    algorithm: "hmac-sha256";
    secret: string;
    keyPrefix: "pak_v1";
  };
  snapshots: PersistedQuotaSnapshot[];
};

type PublicQuotaWindow = {
  status: PublicQuotaStatus;
  usedPercent?: number;
  resetAt?: string;
  observedAt?: string;
  source?: QuotaEvidenceSource;
};

type PublicQuotaSnapshot = Record<QuotaWindowName, PublicQuotaWindow>;

type AccountView = {
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

type PublicAccountView = Omit<AccountView, "raw"> & {
  quota: PublicQuotaSnapshot;
};

type SelectorLogLine = {
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

type CodexSelectionLogLine = {
  timestamp: string;
  auth: string;
  provider: string;
  raw: string;
  fileName: string;
  label: string;
  type: string;
};

type ProxyModelView = {
  id: string;
  created: number;
  ownedBy: string;
};

type RequestLogLine = {
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

type LogSummary = {
  latestSelection: SelectorLogLine | null;
  latestCodexSelection: CodexSelectionLogLine | null;
  recentSelections: SelectorLogLine[];
  latestRequest: RequestLogLine | null;
  recentRequests: RequestLogLine[];
};

type DashboardState = {
  paths: PublicDashboardPaths;
  config: PublicProxyConfig | null;
  accounts: PublicAccountView[];
  selectedAccount: PublicAccountView | null;
  models: ProxyModelView[];
  logSummary: LogSummary;
  errors: string[];
  lastRefreshedAt: string;
};

type DashboardOptions = {
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
  beforeQuotaSnapshotStateWrite?: () => Promise<void> | void;
};

type TestRequestOptions = {
  model?: string;
  prompt?: string;
  maxOutputTokens?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseOptionalInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return fallback;
}

function asHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function normalizeProxyAccountLocalIdentity(value: string): string {
  return path.basename(value).replace(/\.disabled$/, "");
}

function emptyPublicQuotaSnapshot(): PublicQuotaSnapshot {
  return {
    primary5h: { status: "unknown" },
    weekly: { status: "unknown" },
  };
}

function normalizeUsedPercent(value: number): number | undefined {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  if (rounded < 0 || rounded > 100) {
    return undefined;
  }
  return rounded;
}

function observedMsFromIso(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function evidenceIsNewer(
  next: PersistedQuotaWindowEvidence,
  current: PersistedQuotaWindowEvidence | undefined,
): boolean {
  if (!current) {
    return true;
  }
  return observedMsFromIso(next.observedAt) > observedMsFromIso(current.observedAt);
}

function publicQuotaWindow(
  evidence: PersistedQuotaWindowEvidence | undefined,
  nowMs = Date.now(),
): PublicQuotaWindow {
  if (!evidence) {
    return { status: "unknown" };
  }
  const resetMs = evidence.resetAt ? Date.parse(evidence.resetAt) : NaN;
  const status: PublicQuotaStatus =
    Number.isFinite(resetMs) && resetMs > nowMs ? "current" : "refresh-needed";
  return {
    status,
    usedPercent: evidence.usedPercent,
    resetAt: evidence.resetAt,
    observedAt: evidence.observedAt,
    source: evidence.source,
  };
}

function toPublicQuotaSnapshot(
  snapshot: PersistedQuotaSnapshot | undefined,
  nowMs = Date.now(),
): PublicQuotaSnapshot {
  if (!snapshot) {
    return emptyPublicQuotaSnapshot();
  }
  return {
    primary5h: publicQuotaWindow(snapshot.primary5h, nowMs),
    weekly: publicQuotaWindow(snapshot.weekly, nowMs),
  };
}

function defaultCliProxyBin(platform = process.platform): string {
  return platform === "win32" ? WINDOWS_CLI_PROXY_BIN : "cli-proxy-api";
}

function resolveCliProxyBin(options: Pick<DashboardOptions, "cliProxyBin"> = {}): string {
  return options.cliProxyBin ?? process.env.CLI_PROXY_API_BIN ?? defaultCliProxyBin();
}

function resolveCodexBin(options: Pick<DashboardOptions, "codexBin"> = {}): string {
  if (options.codexBin) return options.codexBin;
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const localBin = path.join(path.dirname(process.execPath), process.platform === "win32" ? "codex.exe" : "codex");
  if (existsSync(localBin)) {
    return localBin;
  }
  return "codex";
}

async function queryCodexAppServer(
  codexBin: string,
  method: string,
  params: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(codexBin, ["app-server", "--stdio"]);

    let stdoutText = "";
    let stderrText = "";
    let isFinished = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (!child.killed) {
        child.kill();
      }
    };

    const finish = (error: Error | null, result?: unknown) => {
      if (isFinished) return;
      isFinished = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    timer = setTimeout(() => {
      finish(new Error("Timeout waiting for app-server response on method " + method));
    }, timeoutMs);

    child.on("error", (err) => {
      finish(err);
    });

    child.on("exit", (code) => {
      if (!isFinished) {
        finish(
          new Error(
            "codex app-server process exited early with code " + code + ". Stderr: " + stderrText.trim()
          )
        );
      }
    });

    let buffer = "";
    const processBuffer = () => {
      let lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          handleMessage(msg);
        } catch {}
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      processBuffer();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += chunk.toString("utf8");
    });

    // Step 1: Write initialize request
    const initReq = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "cliproxy-dashboard",
          title: "Cliproxy Dashboard",
          version: "1.0.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      },
    };
    child.stdin.write(JSON.stringify(initReq) + "\n");

    let step = "initializing";

    function handleMessage(msg: any) {
      if (step === "initializing") {
        if (msg.id === 1) {
          if (msg.error) {
            finish(new Error("Initialization failed: " + (msg.error.message || JSON.stringify(msg.error))));
            return;
          }
          // Initialized successfully!
          step = "initialized";
          // Send initialized notification
          const initializedNotif = {
            jsonrpc: "2.0",
            method: "initialized",
          };
          child.stdin.write(JSON.stringify(initializedNotif) + "\n");

          // Now send the actual request
          const actualReq = {
            jsonrpc: "2.0",
            id: 2,
            method,
            params,
          };
          child.stdin.write(JSON.stringify(actualReq) + "\n");
        }
      } else if (step === "initialized") {
        if (msg.id === 2) {
          if (msg.error) {
            const errMsg = msg.error.message || "Unknown JSON-RPC error";
            const err = new Error(errMsg);
            (err as any).code = msg.error.code;
            finish(err);
          } else {
            finish(null, msg.result);
          }
        }
      }
    }
  });
}

function buildOpenUrlCommand(
  url: string,
  platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return { command: "xdg-open", args: [url] };
}

function buildStuckOauthCleanupCommand(
  platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$self = $PID",
      "Get-CimInstance Win32_Process",
      "  | Where-Object { $_.ProcessId -ne $self -and $_.CommandLine -match 'cli-proxy-api' -and $_.CommandLine -match '-codex-login' }",
      "  | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    ].join("; ");
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
    };
  }
  return { command: "pkill", args: ["-f", "cli-proxy-api.*-codex-login"] };
}

async function cleanupStuckOauthLogins(): Promise<void> {
  const cleanup = buildStuckOauthCleanupCommand();
  const child = spawn(cleanup.command, cleanup.args, {
    detached: false,
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function openExternalUrl(url: string): void {
  const opener = buildOpenUrlCommand(url);
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

function safeBasename(value: string): string {
  const base = path.basename(value);
  if (base !== value) {
    throw new Error(`Invalid file name: ${value}`);
  }
  return base;
}

function resolveAccountPath(authDir: string, fileName: string): string {
  const resolved = path.resolve(authDir, safeBasename(fileName));
  const prefix = `${path.resolve(authDir)}${path.sep}`;
  if (resolved !== path.resolve(authDir) && !resolved.startsWith(prefix)) {
    throw new Error(`Account file escapes auth dir: ${fileName}`);
  }
  return resolved;
}

function inferPlanFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.json(?:\.disabled)?$/, "");
  const parts = stem.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

function parseJwtExp(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (typeof payload.exp === "number") {
        return new Date(payload.exp * 1000).toISOString();
      }
    }
  } catch {}
  return null;
}

function chooseInboundKey(raw: Record<string, unknown> | null): string | null {
  const apiKeys = raw && Array.isArray(raw["api-keys"]) ? raw["api-keys"] : [];
  const keys = apiKeys.filter((value): value is string => typeof value === "string");
  const codex = keys.find((key) => key.toLowerCase().includes("codex"));
  return codex ?? keys[0] ?? null;
}

function normalizeConfig(raw: unknown, pathName: string): ProxyConfig | null {
  if (!isRecord(raw)) {
    return null;
  }
  const routing = isRecord(raw.routing) ? raw.routing : null;
  const apiKeys = Array.isArray(raw["api-keys"])
    ? raw["api-keys"].filter((value): value is string => typeof value === "string")
    : [];
  return {
    raw,
    path: pathName,
    port: parseOptionalInteger(raw.port, DEFAULT_PROXY_PORT),
    authDir: asString(raw["auth-dir"], DEFAULT_AUTH_DIR),
    routingStrategy: asString(routing?.strategy, "fill-first"),
    sessionAffinity: asBoolean(routing?.["session-affinity"], false),
    apiKeys,
  };
}

function publicConfig(config: ProxyConfig | null): PublicProxyConfig | null {
  if (!config) {
    return null;
  }
  const { raw: _raw, apiKeys, ...publicConfigValue } = config;
  return {
    ...publicConfigValue,
    apiKeysConfigured: apiKeys.length > 0,
    apiKeyCount: apiKeys.length,
  };
}

function publicDashboardPaths(paths: DashboardPaths): PublicDashboardPaths {
  const { inboundKey: _inboundKey, ...publicPaths } = paths;
  return {
    ...publicPaths,
    inboundKeyConfigured: Boolean(paths.inboundKey),
  };
}

function defaultQuotaSnapshotStatePath(authDir: string): string {
  return path.join(authDir, DASHBOARD_STATE_DIR_NAME, QUOTA_SNAPSHOT_STATE_FILE_NAME);
}

function resolveQuotaSnapshotStatePath(authDir: string, overridePath?: string): string {
  return path.resolve(overridePath ?? defaultQuotaSnapshotStatePath(authDir));
}

function isCodexCredentialFileName(fileName: string): boolean {
  return /^codex-.*\.json(?:\.disabled)?$/.test(fileName);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function ensureOwnerOnlyDirectory(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  const dirStat = await lstat(dirPath);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error("Quota snapshot state directory must be a regular directory");
  }
  try {
    await chmod(dirPath, 0o700);
  } catch {
    // chmod is best-effort on platforms that do not support POSIX modes.
  }
}

async function validateQuotaSnapshotStatePath(
  stateFilePath: string,
  authDir: string,
  configPath: string,
): Promise<void> {
  const resolvedFilePath = path.resolve(stateFilePath);
  const stateRoot = path.resolve(authDir, DASHBOARD_STATE_DIR_NAME);
  const stateDir = path.dirname(resolvedFilePath);
  const fileName = path.basename(resolvedFilePath);
  if (!fileName || fileName === "." || fileName === "..") {
    throw new Error("Quota snapshot state path must name a file");
  }
  const rootRelativePath = path.relative(stateRoot, resolvedFilePath);
  if (rootRelativePath.startsWith("..") || path.isAbsolute(rootRelativePath)) {
    throw new Error("Quota snapshot state path escapes the dashboard state directory");
  }
  if (path.resolve(stateDir) !== stateRoot) {
    throw new Error("Quota snapshot state path must be directly inside the dashboard state directory");
  }

  const resolvedConfigPath = path.resolve(configPath);
  if (resolvedFilePath === resolvedConfigPath) {
    throw new Error("Quota snapshot state path must not be the proxy config file");
  }
  if (path.dirname(resolvedFilePath) === path.resolve(authDir) && isCodexCredentialFileName(fileName)) {
    throw new Error("Quota snapshot state path must not be a Proxy Account credential file");
  }

  await ensureOwnerOnlyDirectory(stateRoot);
  const stateDirRealPath = await realpath(stateRoot);
  const expectedFilePath = path.join(stateDirRealPath, fileName);

  try {
    const fileStat = await lstat(resolvedFilePath);
    if (fileStat.isSymbolicLink()) {
      throw new Error("Quota snapshot state path must not be a symlink");
    }
    if (!fileStat.isFile()) {
      throw new Error("Quota snapshot state path must be a regular file");
    }
    const fileRealPath = await realpath(resolvedFilePath);
    const relative = path.relative(stateDirRealPath, fileRealPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Quota snapshot state path escapes the dashboard state directory");
    }
  } catch (error) {
    if (!isEnoent(error)) {
      throw error;
    }
    const relative = path.relative(stateDirRealPath, expectedFilePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Quota snapshot state path escapes the dashboard state directory");
    }
  }
}

function createEmptyQuotaSnapshotStore(): PersistedQuotaSnapshotStore {
  return {
    schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION,
    keyDerivation: {
      algorithm: "hmac-sha256",
      secret: randomBytes(32).toString("base64url"),
      keyPrefix: "pak_v1",
    },
    snapshots: [],
  };
}

function normalizeQuotaEvidence(raw: unknown): PersistedQuotaWindowEvidence | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const source = raw.source === "identity-bound-read" ? "identity-bound-read" : raw.source === "response-header" ? "response-header" : undefined;
  const observedAt = typeof raw.observedAt === "string" && Number.isFinite(Date.parse(raw.observedAt))
    ? new Date(Date.parse(raw.observedAt)).toISOString()
    : "";
  if (!source || !observedAt) {
    return undefined;
  }
  const usedPercent =
    typeof raw.usedPercent === "number" ? normalizeUsedPercent(raw.usedPercent) : undefined;
  const resetAt =
    typeof raw.resetAt === "string" && Number.isFinite(Date.parse(raw.resetAt))
      ? new Date(Date.parse(raw.resetAt)).toISOString()
      : undefined;
  const debugStatus =
    typeof raw.debugStatus === "string" && raw.debugStatus.length <= 80 ? raw.debugStatus : undefined;
  return {
    ...(usedPercent === undefined ? {} : { usedPercent }),
    ...(resetAt === undefined ? {} : { resetAt }),
    observedAt,
    source,
    ...(debugStatus === undefined ? {} : { debugStatus }),
  };
}

function quotaEvidenceWasSanitized(
  raw: unknown,
  normalized: PersistedQuotaWindowEvidence | undefined,
): boolean {
  if (!isRecord(raw)) {
    return normalized !== undefined;
  }
  const allowedEvidenceKeys = new Set(["usedPercent", "resetAt", "observedAt", "source", "debugStatus"]);
  for (const key of Object.keys(raw)) {
    if (!allowedEvidenceKeys.has(key)) {
      return true;
    }
  }
  if (!normalized) {
    return true;
  }
  if ("usedPercent" in raw) {
    if (typeof raw.usedPercent !== "number") {
      return true;
    }
    if (normalizeUsedPercent(raw.usedPercent) !== normalized.usedPercent) {
      return true;
    }
  }
  if ("resetAt" in raw && typeof raw.resetAt !== "string") {
    return true;
  }
  if (typeof raw.resetAt === "string") {
    const parsedResetAt = Date.parse(raw.resetAt);
    const canonicalResetAt = Number.isFinite(parsedResetAt) ? new Date(parsedResetAt).toISOString() : undefined;
    if (canonicalResetAt !== normalized.resetAt) {
      return true;
    }
  }
  const parsedObservedAt = typeof raw.observedAt === "string" ? Date.parse(raw.observedAt) : NaN;
  if (!Number.isFinite(parsedObservedAt) || new Date(parsedObservedAt).toISOString() !== normalized.observedAt) {
    return true;
  }
  if (raw.source !== normalized.source) {
    return true;
  }
  if (typeof raw.debugStatus === "string" && raw.debugStatus.length <= 80) {
    return raw.debugStatus !== normalized.debugStatus;
  }
  return raw.debugStatus !== undefined;
}

function normalizePersistedQuotaSnapshotStore(
  raw: unknown,
): { store: PersistedQuotaSnapshotStore; dirty: boolean } | null {
  if (!isRecord(raw) || raw.schemaVersion !== QUOTA_SNAPSHOT_SCHEMA_VERSION) {
    return null;
  }
  let dirty = false;
  const allowedRootKeys = new Set(["schemaVersion", "keyDerivation", "snapshots"]);
  for (const key of Object.keys(raw)) {
    if (!allowedRootKeys.has(key)) {
      dirty = true;
    }
  }
  const keyDerivation = isRecord(raw.keyDerivation) ? raw.keyDerivation : null;
  const secret = typeof keyDerivation?.secret === "string" ? keyDerivation.secret : "";
  if (keyDerivation) {
    const allowedKeyDerivationKeys = new Set(["algorithm", "secret", "keyPrefix"]);
    for (const key of Object.keys(keyDerivation)) {
      if (!allowedKeyDerivationKeys.has(key)) {
        dirty = true;
      }
    }
  }
  if (
    keyDerivation?.algorithm !== "hmac-sha256" ||
    keyDerivation?.keyPrefix !== "pak_v1" ||
    !/^[A-Za-z0-9_-]{32,}$/.test(secret)
  ) {
    return null;
  }

  const snapshots: PersistedQuotaSnapshot[] = [];
  const rawSnapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
  for (const rawSnapshot of rawSnapshots) {
    if (!isRecord(rawSnapshot) || typeof rawSnapshot.proxyAccountKey !== "string") {
      dirty = true;
      continue;
    }
    const allowedSnapshotKeys = new Set(["proxyAccountKey", "primary5h", "weekly"]);
    for (const key of Object.keys(rawSnapshot)) {
      if (!allowedSnapshotKeys.has(key)) {
        dirty = true;
      }
    }
    if (!/^pak_v1_[A-Za-z0-9_-]{32,}$/.test(rawSnapshot.proxyAccountKey)) {
      dirty = true;
      continue;
    }
    const primary5h = normalizeQuotaEvidence(rawSnapshot.primary5h);
    const weekly = normalizeQuotaEvidence(rawSnapshot.weekly);
    if (!primary5h && !weekly) {
      dirty = true;
      continue;
    }
    if (rawSnapshot.primary5h !== undefined) {
      dirty = quotaEvidenceWasSanitized(rawSnapshot.primary5h, primary5h) || dirty;
    }
    if (rawSnapshot.weekly !== undefined) {
      dirty = quotaEvidenceWasSanitized(rawSnapshot.weekly, weekly) || dirty;
    }
    snapshots.push({
      proxyAccountKey: rawSnapshot.proxyAccountKey,
      ...(primary5h ? { primary5h } : {}),
      ...(weekly ? { weekly } : {}),
    });
  }

  return {
    store: {
      schemaVersion: QUOTA_SNAPSHOT_SCHEMA_VERSION,
      keyDerivation: {
        algorithm: "hmac-sha256",
        secret,
        keyPrefix: "pak_v1",
      },
      snapshots,
    },
    dirty,
  };
}

async function readQuotaSnapshotStoreFile(
  stateFilePath: string,
): Promise<{ store: PersistedQuotaSnapshotStore; error?: string; dirty: boolean }> {
  try {
    const text = await readFile(stateFilePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    const normalized = normalizePersistedQuotaSnapshotStore(parsed);
    if (!normalized) {
      return {
        store: createEmptyQuotaSnapshotStore(),
        error: "Quota snapshot state file was invalid and was reinitialized",
        dirty: true,
      };
    }
    return { store: normalized.store, dirty: normalized.dirty };
  } catch (error) {
    if (isEnoent(error)) {
      return { store: createEmptyQuotaSnapshotStore(), dirty: true };
    }
    return {
      store: createEmptyQuotaSnapshotStore(),
      error: "Quota snapshot state file could not be read and was reinitialized",
      dirty: true,
    };
  }
}

async function atomicWriteOwnerOnlyJson(filePath: string, value: unknown): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await writeFile(tempPath, text, { encoding: "utf8", mode: 0o600 });
    try {
      await chmod(tempPath, 0o600);
    } catch {}
    await rename(tempPath, filePath);
    try {
      await chmod(filePath, 0o600);
    } catch {}
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {}
    throw error;
  }
}

const quotaSnapshotStateLocks = new Map<string, Promise<void>>();

async function withQuotaSnapshotStateLock<T>(stateFilePath: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(stateFilePath);
  const previous = quotaSnapshotStateLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  const next = current.then(
    () => undefined,
    () => undefined,
  );
  quotaSnapshotStateLocks.set(key, next);
  try {
    return await current;
  } finally {
    if (quotaSnapshotStateLocks.get(key) === next) {
      quotaSnapshotStateLocks.delete(key);
    }
  }
}

function deriveProxyAccountKey(store: PersistedQuotaSnapshotStore, canonicalLocalIdentity: string): string {
  const digest = createHmac("sha256", Buffer.from(store.keyDerivation.secret, "base64url"))
    .update("cliproxy-dashboard proxy-account-key v1\0")
    .update(canonicalLocalIdentity, "utf8")
    .digest("base64url");
  return `${store.keyDerivation.keyPrefix}_${digest}`;
}

function mergeQuotaWindowEvidence(
  snapshot: PersistedQuotaSnapshot,
  windowName: QuotaWindowName,
  evidence: PersistedQuotaWindowEvidence | undefined,
): boolean {
  if (!evidence) {
    return false;
  }
  const current = snapshot[windowName];
  if (!evidenceIsNewer(evidence, current)) {
    return false;
  }
  snapshot[windowName] = evidence;
  return true;
}

function hasQuotaEvidence(snapshot: PersistedQuotaSnapshot): boolean {
  return Boolean(snapshot.primary5h || snapshot.weekly);
}

async function readConfig(configPath: string): Promise<ProxyConfig | null> {
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = YAML.parse(text) as unknown;
    return normalizeConfig(parsed, configPath);
  } catch {
    return null;
  }
}

async function resolveDashboardPaths(options: DashboardOptions = {}): Promise<DashboardPaths> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const config = await readConfig(configPath);
  const authDir = options.authDir ?? config?.authDir ?? DEFAULT_AUTH_DIR;
  const proxyPort = parseOptionalInteger(options.proxyPort ?? config?.port, DEFAULT_PROXY_PORT);
  const proxyUrl = options.proxyUrl ?? `http://${DEFAULT_HOST}:${proxyPort}`;
  const logsDir = path.join(authDir, "logs");
  const mainLogPath = options.mainLogPath ?? path.join(authDir, "logs", "main.log");
  const quotaSnapshotStatePath = resolveQuotaSnapshotStatePath(authDir, options.quotaSnapshotStatePath);
  const backupRoot = options.backupRoot ?? DEFAULT_BACKUP_ROOT;
  const inboundKey = options.inboundKey ?? chooseInboundKey(config?.raw ?? null);
  return {
    configPath,
    authDir,
    backupRoot,
    logsDir,
    mainLogPath,
    quotaSnapshotStatePath,
    proxyUrl,
    proxyPort,
    inboundKey,
  };
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeAccount(filePath: string, raw: Record<string, unknown>): AccountView {
  const fileName = path.basename(filePath);
  const disabled = asBoolean(raw.disabled, false) || fileName.endsWith(".disabled");
  const priority =
    typeof raw.priority === "number" && Number.isInteger(raw.priority)
      ? raw.priority
      : DEFAULT_PRIORITY;
  const explicitPriority = typeof raw.priority === "number" && Number.isInteger(raw.priority);
  const accountId = asString(raw.account_id, "");
  const validityStatusRaw = asString(raw.validity_status, "unverified");
  const validityStatus = (validityStatusRaw === "valid" || validityStatusRaw === "invalid" ? validityStatusRaw : "unverified") as "valid" | "invalid" | "unverified";

    let subscriptionPlan: string | undefined;
    let subscriptionActiveUntil: string | undefined;
    let subscriptionLastChecked: string | undefined;

  const idToken = asString(raw.id_token, "");
  if (idToken) {
    try {
      const parts = idToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (isRecord(payload)) {
            const openAiAuth = payload["https://api.openai.com/auth"];
            if (isRecord(openAiAuth)) {
              subscriptionPlan = asString(openAiAuth.chatgpt_plan_type, "") || undefined;
              subscriptionActiveUntil = asString(openAiAuth.chatgpt_subscription_active_until, "") || undefined;
              subscriptionLastChecked = asString(openAiAuth.chatgpt_subscription_last_checked, "") || undefined;
            }
          }
        }
    } catch {}
  }

  return {
    fileName,
    path: filePath,
    email: asString(raw.email, fileName.replace(/^codex-/, "")),
    priority,
    explicitPriority,
    disabled,
    note: asString(raw.note, ""),
    accountId,
    accountIdShort: accountId ? accountId.slice(0, 8) : "",
    type: asString(raw.type, ""),
    plan: inferPlanFromFileName(fileName),
    expired: asString(raw.expired, ""),
    lastRefresh: asString(raw.last_refresh, ""),
      validityStatus,
      validationError: asString(raw.validation_error, ""),
      subscriptionPlan,
      subscriptionActiveUntil,
      subscriptionLastChecked,
      raw,
    };
  }

function publicAccount(account: AccountView, quota = emptyPublicQuotaSnapshot()): PublicAccountView {
  const { raw: _raw, ...publicAccountValue } = account;
  return {
    ...publicAccountValue,
    quota,
  };
}

function normalizeModel(raw: unknown): ProxyModelView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = asString(raw.id, "").trim();
  if (!id) {
    return null;
  }
  return {
    id,
    created: parseOptionalInteger(raw.created, 0),
    ownedBy: asString(raw.owned_by, ""),
  };
}

function sortModels(models: ProxyModelView[]): ProxyModelView[] {
  return [...models].sort((left, right) => {
    if (left.id !== right.id) {
      return left.id.localeCompare(right.id);
    }
    if (left.ownedBy !== right.ownedBy) {
      return left.ownedBy.localeCompare(right.ownedBy);
    }
    return right.created - left.created;
  });
}

function sortAccounts(accounts: AccountView[]): AccountView[] {
  return [...accounts].sort((left, right) => {
    if (left.disabled !== right.disabled) {
      return Number(left.disabled) - Number(right.disabled);
    }
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.fileName.localeCompare(right.fileName);
  });
}

async function readProxyModels(
  proxyUrl: string,
  inboundKey: string | null,
): Promise<{ models: ProxyModelView[]; errors: string[] }> {
  if (!inboundKey) {
    return { models: [], errors: ["No inbound proxy key was found in config.yaml"] };
  }
  try {
    const response = await fetch(`${proxyUrl}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${inboundKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      return {
        models: [],
        errors: [`Model list request failed: ${response.status} ${response.statusText}`],
      };
    }
    const parsed = (await response.json()) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
      return { models: [], errors: ["Model list response was not a valid OpenAI model list"] };
    }
    const models = parsed.data
      .map(normalizeModel)
      .filter((model): model is ProxyModelView => model !== null);
    return { models: sortModels(models), errors: [] };
  } catch {
    return { models: [], errors: [`Could not read model list from ${proxyUrl}/v1/models`] };
  }
}

async function readAccounts(
  authDir: string,
): Promise<{ accounts: AccountView[]; errors: string[] }> {
  const errors: string[] = [];
  try {
    await access(authDir);
  } catch {
    return { accounts: [], errors };
  }

  const entries = await readdir(authDir, { withFileTypes: true });
  const accounts: AccountView[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/^codex-.*\.json(?:\.disabled)?$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(authDir, entry.name);
    const raw = await readJsonObject(filePath);
    if (!raw) {
      errors.push(`Could not read ${entry.name}`);
      continue;
    }
    accounts.push(normalizeAccount(filePath, raw));
  }
  return { accounts: sortAccounts(accounts), errors };
}

async function readTailText(filePath: string, limitBytes = DEFAULT_LOG_BYTES): Promise<string> {
  try {
    const fileHandle = await open(filePath, "r");
    try {
      const fileStat = await fileHandle.stat();
      const size = Math.min(fileStat.size, limitBytes);
      const buffer = Buffer.alloc(size);
      if (size === 0) {
        return "";
      }
      await fileHandle.read(buffer, 0, size, fileStat.size - size);
      return buffer.toString("utf8");
    } finally {
      await fileHandle.close();
    }
  } catch {
    return "";
  }
}

const selectorLinePattern =
  /^\[(?<timestamp>[^\]]+)\] \[(?<traceId>[^\]]+)\] \[(?<level>[^\]]+)\] \[(?<source>[^\]]+)\] (?<message>.*)$/;
const selectorDetailsPattern =
  /session=(?<session>\S+)\s+auth=(?<auth>\S+)\s+provider=(?<provider>\S+)\s+model=(?<model>\S+)/;
const requestLinePattern =
  /^\[(?<timestamp>[^\]]+)\] \[(?<traceId>[^\]]+)\] \[(?<level>[^\]]+)\] \[(?<source>[^\]]+)\] (?<status>\d{3}) \|\s*(?<duration>[^|]+?)\s*\|\s*(?<client>[^|]+?)\s*\|\s*(?<method>[A-Z]+)\s+"(?<path>[^"]+)"/;

function parseSelectorLine(line: string): SelectorLogLine | null {
  const outer = selectorLinePattern.exec(line);
  if (!outer?.groups) {
    return null;
  }
  const detail = selectorDetailsPattern.exec(outer.groups.message);
  if (!detail?.groups) {
    return null;
  }
  return {
    timestamp: outer.groups.timestamp,
    traceId: outer.groups.traceId,
    level: outer.groups.level.trim(),
    source: outer.groups.source,
    session: detail.groups.session,
    auth: detail.groups.auth,
    provider: detail.groups.provider,
    model: detail.groups.model,
    raw: line,
  };
}

function parseRequestLine(line: string): RequestLogLine | null {
  const match = requestLinePattern.exec(line);
  if (!match?.groups) {
    return null;
  }
  return {
    timestamp: match.groups.timestamp,
    traceId: match.groups.traceId,
    level: match.groups.level.trim(),
    source: match.groups.source,
    status: Number(match.groups.status),
    duration: match.groups.duration.trim(),
    client: match.groups.client.trim(),
    method: match.groups.method,
    path: match.groups.path,
    raw: line,
  };
}

const responseLogFilePattern = /^v1-responses-.*\.log$/;
const responseAuthPattern =
  /^Auth:\s+provider=(?<provider>[^,]+),\s+auth_id=(?<auth>[^,]+),\s+label=(?<label>[^,]+),\s+type=(?<type>\S+)\s*$/;
const responseTimestampPattern = /^Timestamp:\s*(?<timestamp>.+)$/;

function parseCodexSelectionFromResponseLog(
  text: string,
  fileName: string,
): CodexSelectionLogLine | null {
  const lines = text.split(/\r?\n/);
  const authLine = lines.find((line) => line.trimStart().startsWith("Auth: provider=codex,"));
  if (!authLine) {
    return null;
  }
  const match = responseAuthPattern.exec(authLine.trim());
  if (!match?.groups) {
    return null;
  }
  const timestampLine = lines.find((line) => responseTimestampPattern.test(line.trim()));
  const timestamp = timestampLine?.trim().match(responseTimestampPattern)?.groups?.timestamp ?? "";
  return {
    timestamp,
    auth: match.groups.auth,
    provider: match.groups.provider,
    raw: authLine.trim(),
    fileName,
    label: match.groups.label,
    type: match.groups.type,
  };
}

async function readLatestCodexSelection(logsDir: string): Promise<CodexSelectionLogLine | null> {
  try {
    await access(logsDir);
  } catch {
    return null;
  }

  const entries = await readdir(logsDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && responseLogFilePattern.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(logsDir, entry.name);
        try {
          const stats = await stat(filePath);
          return { fileName: entry.name, filePath, mtimeMs: stats.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const recentFiles = files
    .filter(
      (entry): entry is { fileName: string; filePath: string; mtimeMs: number } => entry !== null,
    )
    .sort(
      (left, right) => right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName),
    )
    .slice(0, 10);

  for (const entry of recentFiles) {
    try {
      const text = await readFile(entry.filePath, "utf8");
      const parsed = parseCodexSelectionFromResponseLog(text, entry.fileName);
      if (parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function collectLogMatches<T>(
  text: string,
  parser: (line: string) => T | null,
  limit: number,
): T[] {
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const matches: T[] = [];
  for (let index = lines.length - 1; index >= 0 && matches.length < limit; index -= 1) {
    const parsed = parser(lines[index].trimEnd());
    if (parsed) {
      matches.push(parsed);
    }
  }
  return matches;
}

async function readLogSummary(logPath: string): Promise<LogSummary> {
  const tailText = await readTailText(logPath);
  const recentSelections = collectLogMatches(tailText, parseSelectorLine, 25);
  const recentRequests = collectLogMatches(tailText, parseRequestLine, 25);
  const latestSelection = recentSelections[0] ?? null;
  return {
    latestSelection,
    latestCodexSelection: null,
    recentSelections,
    latestRequest: recentRequests[0] ?? null,
    recentRequests,
  };
}

type QuotaSnapshotUpdate = {
  canonicalLocalIdentity: string;
  primary5h?: PersistedQuotaWindowEvidence;
  weekly?: PersistedQuotaWindowEvidence;
};

function parseResponseTimestampMs(lines: string[], fallbackMs: number): number {
  const timestampLine = lines.find((line) => responseTimestampPattern.test(line.trim()));
  const timestamp = timestampLine?.trim().match(responseTimestampPattern)?.groups?.timestamp ?? "";
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function getResponseHeaderNumber(lines: string[], name: string): number | undefined {
  const lowerName = name.toLowerCase();
  const line = lines.find((candidate) => candidate.toLowerCase().startsWith(`${lowerName}:`));
  if (!line) {
    return undefined;
  }
  const value = Number(line.slice(line.indexOf(":") + 1).trim());
  return Number.isFinite(value) ? value : undefined;
}

function epochHeaderToIso(value: number | undefined): string | undefined {
  if (value === undefined || value < 0) {
    return undefined;
  }
  const epochMs = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(epochMs).toISOString();
}

function quotaWindowEvidenceFromHeaders(
  lines: string[],
  observedMs: number,
  usedHeader: string,
  resetAfterHeader: string,
  resetAtHeader: string,
): PersistedQuotaWindowEvidence | undefined {
  const usedPercent = normalizeUsedPercent(getResponseHeaderNumber(lines, usedHeader) ?? NaN);
  if (usedPercent === undefined) {
    return undefined;
  }
  const resetAtRaw = getResponseHeaderNumber(lines, resetAtHeader);
  const resetAfterSeconds = getResponseHeaderNumber(lines, resetAfterHeader);
  const resetAt =
    epochHeaderToIso(resetAtRaw) ??
    (resetAfterSeconds === undefined ? undefined : new Date(observedMs + resetAfterSeconds * 1000).toISOString());
  return {
    usedPercent,
    ...(resetAt ? { resetAt } : {}),
    observedAt: new Date(observedMs).toISOString(),
    source: "response-header",
  };
}

async function readResponseHeaderQuotaUpdates(
  logsDir: string,
): Promise<QuotaSnapshotUpdate[]> {
  const updates: QuotaSnapshotUpdate[] = [];
  try {
    await access(logsDir);
  } catch {
    return updates;
  }

  const entries = await readdir(logsDir, { withFileTypes: true });
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  const filesToParse = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && responseLogFilePattern.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(logsDir, entry.name);
        try {
          const stats = await stat(filePath);
          const ageMs = now - stats.mtimeMs;
          if (ageMs <= oneWeekMs) {
            return { name: entry.name, filePath, mtimeMs: stats.mtimeMs };
          }
        } catch {}
        return null;
      }),
  );

  const activeFiles = filesToParse.filter(
    (f): f is { name: string; filePath: string; mtimeMs: number } => f !== null,
  );

  activeFiles.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));

  for (const file of activeFiles) {
    try {
      const text = await readFile(file.filePath, "utf8");
      const lines = text.split(/\r?\n/);
      const authLine = lines.find((line) => line.trimStart().startsWith("Auth: provider=codex,"));
      if (!authLine) {
        continue;
      }
      const match = responseAuthPattern.exec(authLine.trim());
      if (!match?.groups) {
        continue;
      }
      const observedMs = parseResponseTimestampMs(lines, file.mtimeMs);
      const primary5h = quotaWindowEvidenceFromHeaders(
        lines,
        observedMs,
        "X-Codex-Primary-Used-Percent",
        "X-Codex-Primary-Reset-After-Seconds",
        "X-Codex-Primary-Reset-At",
      );
      const weekly = quotaWindowEvidenceFromHeaders(
        lines,
        observedMs,
        "X-Codex-Secondary-Used-Percent",
        "X-Codex-Secondary-Reset-After-Seconds",
        "X-Codex-Secondary-Reset-At",
      );
      if (!primary5h && !weekly) {
        continue;
      }
      updates.push({
        canonicalLocalIdentity: normalizeProxyAccountLocalIdentity(match.groups.auth),
        ...(primary5h ? { primary5h } : {}),
        ...(weekly ? { weekly } : {}),
      });
    } catch {}
  }

  return updates;
}

function mergeQuotaSnapshotUpdates(
  store: PersistedQuotaSnapshotStore,
  accounts: AccountView[],
  updates: QuotaSnapshotUpdate[],
): { snapshotsByCanonicalIdentity: Map<string, PersistedQuotaSnapshot>; changed: boolean } {
  let changed = false;
  const snapshotsByKey = new Map<string, PersistedQuotaSnapshot>();
  for (const snapshot of store.snapshots) {
    snapshotsByKey.set(snapshot.proxyAccountKey, snapshot);
  }

  const keyByCanonicalIdentity = new Map<string, string>();
  for (const account of accounts) {
    const canonicalIdentity = normalizeProxyAccountLocalIdentity(account.fileName);
    if (!keyByCanonicalIdentity.has(canonicalIdentity)) {
      keyByCanonicalIdentity.set(canonicalIdentity, deriveProxyAccountKey(store, canonicalIdentity));
    }
  }

  for (const update of updates) {
    const proxyAccountKey = keyByCanonicalIdentity.get(update.canonicalLocalIdentity);
    if (!proxyAccountKey) {
      continue;
    }
    let snapshot = snapshotsByKey.get(proxyAccountKey);
    if (!snapshot) {
      snapshot = { proxyAccountKey };
      snapshotsByKey.set(proxyAccountKey, snapshot);
      changed = true;
    }
    changed = mergeQuotaWindowEvidence(snapshot, "primary5h", update.primary5h) || changed;
    changed = mergeQuotaWindowEvidence(snapshot, "weekly", update.weekly) || changed;
  }

  store.snapshots = [...snapshotsByKey.values()]
    .filter(hasQuotaEvidence)
    .sort((left, right) => left.proxyAccountKey.localeCompare(right.proxyAccountKey));

  const snapshotsByCanonicalIdentity = new Map<string, PersistedQuotaSnapshot>();
  for (const [canonicalIdentity, proxyAccountKey] of keyByCanonicalIdentity) {
    const snapshot = snapshotsByKey.get(proxyAccountKey);
    if (snapshot && hasQuotaEvidence(snapshot)) {
      snapshotsByCanonicalIdentity.set(canonicalIdentity, snapshot);
    }
  }
  return { snapshotsByCanonicalIdentity, changed };
}

async function readMergedQuotaSnapshots(
  paths: DashboardPaths,
  accounts: AccountView[],
  beforeWrite?: () => Promise<void> | void,
): Promise<{ snapshotsByCanonicalIdentity: Map<string, PersistedQuotaSnapshot>; errors: string[] }> {
  const updates = await readResponseHeaderQuotaUpdates(paths.logsDir);
  const stateFilePath = paths.quotaSnapshotStatePath;

  try {
    return await withQuotaSnapshotStateLock(stateFilePath, async () => {
      await validateQuotaSnapshotStatePath(stateFilePath, paths.authDir, paths.configPath);
      const { store, error, dirty } = await readQuotaSnapshotStoreFile(stateFilePath);
      const merged = mergeQuotaSnapshotUpdates(store, accounts, updates);
      if (dirty || merged.changed) {
        await beforeWrite?.();
        await atomicWriteOwnerOnlyJson(stateFilePath, store);
      }
      return {
        snapshotsByCanonicalIdentity: merged.snapshotsByCanonicalIdentity,
        errors: error ? [error] : [],
      };
    });
  } catch (error) {
    const store = createEmptyQuotaSnapshotStore();
    const merged = mergeQuotaSnapshotUpdates(store, accounts, updates);
    const message = error instanceof Error ? error.message : String(error);
    return {
      snapshotsByCanonicalIdentity: merged.snapshotsByCanonicalIdentity,
      errors: [`Quota snapshot state store unavailable: ${message}`],
    };
  }
}

async function readDashboardState(options: DashboardOptions = {}): Promise<DashboardState> {
  const paths = await resolveDashboardPaths(options);
  const [config, accountsResult, modelsResult, logSummary, latestCodexSelectionFromLogs] =
    await Promise.all([
      readConfig(paths.configPath),
      readAccounts(paths.authDir),
      readProxyModels(paths.proxyUrl, paths.inboundKey),
      readLogSummary(paths.mainLogPath),
      readLatestCodexSelection(paths.logsDir),
    ]);
  const quotaSnapshots = await readMergedQuotaSnapshots(
    paths,
    accountsResult.accounts,
    options.beforeQuotaSnapshotStateWrite,
  );
  const latestCodexSelection =
    latestCodexSelectionFromLogs ??
    (logSummary.latestSelection?.auth?.startsWith("codex-")
      ? {
          timestamp: logSummary.latestSelection.timestamp,
          auth: logSummary.latestSelection.auth,
          provider: logSummary.latestSelection.provider,
          raw: logSummary.latestSelection.raw,
          fileName: path.basename(logSummary.latestSelection.auth),
          label: "",
          type: "",
        }
      : null);
  const selectedAccount = latestCodexSelection
    ? (accountsResult.accounts.find(
        (account) =>
          normalizeProxyAccountLocalIdentity(account.fileName) ===
          normalizeProxyAccountLocalIdentity(path.basename(latestCodexSelection.auth)),
      ) ?? null)
    : null;

  const accountsMapped = accountsResult.accounts.map((account) => {
    return {
      ...publicAccount(
        account,
        toPublicQuotaSnapshot(
          quotaSnapshots.snapshotsByCanonicalIdentity.get(
            normalizeProxyAccountLocalIdentity(account.fileName),
          ),
        ),
      ),
    };
  });
  const selectedAccountMapped = selectedAccount
    ? publicAccount(
        selectedAccount,
        toPublicQuotaSnapshot(
          quotaSnapshots.snapshotsByCanonicalIdentity.get(
            normalizeProxyAccountLocalIdentity(selectedAccount.fileName),
          ),
        ),
      )
    : null;

  return {
    paths: publicDashboardPaths(paths),
    config: publicConfig(config),
    accounts: accountsMapped,
    selectedAccount: selectedAccountMapped,
    models: modelsResult.models,
    logSummary: {
      ...logSummary,
      latestCodexSelection,
    },
    errors: [
        ...(config ? [] : [`Could not read proxy config at ${paths.configPath}`]),
        ...accountsResult.errors,
        ...modelsResult.errors,
        ...quotaSnapshots.errors,
        ...(logSummary.latestRequest || logSummary.latestSelection || latestCodexSelection
          ? []
          : [`No recent proxy logs found at ${paths.mainLogPath}`]),
    ],
    lastRefreshedAt: new Date().toISOString(),
  };
}

async function backupFile(filePath: string, backupRoot: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(backupRoot, stamp);
  await mkdir(targetDir, { recursive: true });
  await copyFile(filePath, path.join(targetDir, path.basename(filePath)));
}

async function atomicWriteText(filePath: string, text: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, text, "utf8");
  await rename(tempPath, filePath);
}

async function mutateAccountFile(
  authDir: string,
  backupRoot: string,
  fileName: string,
  mutator: (raw: Record<string, unknown>) => void,
): Promise<AccountView> {
  const filePath = resolveAccountPath(authDir, fileName);
  const raw = await readJsonObject(filePath);
  if (!raw) {
    throw new Error(`Unable to read account file: ${fileName}`);
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  mutator(next);
  await backupFile(filePath, backupRoot);

  const shouldBeDisabled = Boolean(next.disabled);
  const currentlyDisabled = fileName.endsWith(".disabled");
  let targetFileName = fileName;
  if (shouldBeDisabled && !currentlyDisabled) {
    targetFileName = `${fileName}.disabled`;
  } else if (!shouldBeDisabled && currentlyDisabled) {
    targetFileName = fileName.replace(/\.disabled$/, "");
  }

  const targetPath = resolveAccountPath(authDir, targetFileName);
  await atomicWriteText(targetPath, `${JSON.stringify(next, null, 2)}\n`);

  if (targetPath !== filePath) {
    try {
      await unlink(filePath);
    } catch {
      // Ignore
    }
  }

  return normalizeAccount(targetPath, next);
}

async function setAccountPatch(
  authDir: string,
  backupRoot: string,
  fileName: string,
  patch: { priority?: number | null; disabled?: boolean | null; note?: string | null },
): Promise<AccountView> {
  return await mutateAccountFile(authDir, backupRoot, fileName, (raw) => {
    if (patch.priority === null) {
      delete raw.priority;
    } else if (typeof patch.priority === "number" && Number.isInteger(patch.priority)) {
      raw.priority = patch.priority;
    }
    if (typeof patch.disabled === "boolean") {
      raw.disabled = patch.disabled;
    }
    if (patch.note === null) {
      delete raw.note;
    } else if (typeof patch.note === "string") {
      const trimmed = patch.note.trim();
      if (trimmed) {
        raw.note = trimmed;
      } else {
        delete raw.note;
      }
    }
  });
}

async function promotePrimary(
  authDir: string,
  backupRoot: string,
  targetFileName: string,
  backupPriority = DEFAULT_BACKUP_PRIORITY,
): Promise<void> {
  const entries = await readAccounts(authDir);
  const targetPath = resolveAccountPath(authDir, targetFileName);
  const targetName = path.basename(targetPath);
  const target = entries.accounts.find((account) => account.fileName === targetName);
  if (!target) {
    throw new Error(`Unknown account: ${targetFileName}`);
  }
  const targetPriority = Math.max(DEFAULT_PRIORITY, backupPriority + 1);
  for (const account of entries.accounts) {
    if (account.fileName === targetName) {
      await setAccountPatch(authDir, backupRoot, account.fileName, {
        priority: targetPriority,
        disabled: false,
        note: "primary",
      });
      continue;
    }
    await setAccountPatch(authDir, backupRoot, account.fileName, {
      priority: backupPriority,
      note: account.note || "backup",
    });
  }
}

async function setRoutingConfig(
  configPath: string,
  next: { strategy: string; sessionAffinity: boolean },
): Promise<ProxyConfig | null> {
  const existing = await readConfig(configPath);
  if (!existing) {
    throw new Error(`Unable to read proxy config: ${configPath}`);
  }
  const raw = structuredClone(existing.raw) as Record<string, unknown>;
  const routing = isRecord(raw.routing) ? raw.routing : {};
  routing.strategy = next.strategy;
  routing["session-affinity"] = next.sessionAffinity;
  raw.routing = routing;
  await atomicWriteText(configPath, `${YAML.stringify(raw).trimEnd()}\n`);
  return normalizeConfig(raw, configPath);
}

async function startOauthLogin(configPath: string, email?: string, cliProxyBin?: string): Promise<string> {
  const execPath = cliProxyBin ?? resolveCliProxyBin();
  const args = ["--config", configPath, "-codex-login", "-no-browser"];

  const child = spawn(execPath, args, {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });

  child.unref();

  return new Promise<string>((resolve, reject) => {
    let output = "";
    const onData = (data: Buffer) => {
      output += data.toString("utf8");
      const match = output.match(/https:\/\/auth\.openai\.com\/[^\s]*/);
      if (match) {
        cleanup();
        let url = match[0];
        if (email) {
          url += `&login_hint=${encodeURIComponent(email)}`;
        }
        resolve(url);
      }
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Login process exited early with code ${code}`));
    };

    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error("Timeout waiting for login URL from CLI proxy"));
    }, 10000);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    child.stdout?.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

async function pingProxy(proxyUrl: string, inboundKey: string | null): Promise<boolean> {
  if (!inboundKey) {
    return false;
  }
  try {
    const response = await fetch(`${proxyUrl}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${inboundKey}`,
        Accept: "application/json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function sendTestRequest(
  paths: DashboardPaths,
  options: TestRequestOptions,
): Promise<{
  requestId: string;
  ok: boolean;
  status: number;
  responseText: string;
  latestCodexSelection: CodexSelectionLogLine | null;
}> {
  if (!paths.inboundKey) {
    throw new Error("No inbound proxy key was found in config.yaml");
  }
  const requestId = randomUUID();
  const model = options.model?.trim() || DEFAULT_TEST_MODEL;
  const prompt = options.prompt?.trim() || DEFAULT_TEST_PROMPT;
  const maxOutputTokens = Number.isFinite(options.maxOutputTokens ?? NaN)
    ? Math.max(1, Math.trunc(options.maxOutputTokens ?? DEFAULT_TEST_OUTPUT_TOKENS))
    : DEFAULT_TEST_OUTPUT_TOKENS;
  const response = await fetch(`${paths.proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paths.inboundKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Client-Request-Id": requestId,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: maxOutputTokens,
      stream: false,
    }),
  });
  const responseText = await response.text();
  const latestCodexSelection = await readLatestCodexSelection(paths.logsDir);
  return {
    requestId,
    ok: response.ok,
    status: response.status,
    responseText: responseText.slice(0, 4000),
    latestCodexSelection,
  };
}

function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function textResponse(
  res: ServerResponse,
  statusCode: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function isSameOriginRequest(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  const fetchSite = asHeaderValue(headers["sec-fetch-site"]).toLowerCase();
  const origin = asHeaderValue(headers.origin).trim();
  const host = asHeaderValue(headers.host).trim();
  if (origin) {
    if (!host || origin !== `http://${host}`) {
      return false;
    }
  }
  if (fetchSite) {
    return fetchSite === "same-origin" || fetchSite === "none";
  }
  return Boolean(origin);
}

function requiresOperatorToken(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) {
    return false;
  }
  return !(method === "GET" && pathname === "/api/state");
}

function hasValidOperatorToken(req: IncomingMessage, options: DashboardOptions): boolean {
  const expected = options.operatorToken;
  if (!expected) {
    return false;
  }
  return asHeaderValue(req.headers?.[DASHBOARD_OPERATOR_TOKEN_HEADER]).trim() === expected;
}

function htmlPage(operatorToken: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self';"
    />
    <title>Cliproxy Dashboard</title>
    <script>
      (function() {
        const theme = localStorage.getItem("theme") || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        document.documentElement.setAttribute("data-theme", theme);
      })();
    </script>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

      :root {
        color-scheme: dark light;
      }
      
      :root[data-theme="dark"] {
        --bg: #100d0a;
        --bg-gradient: radial-gradient(circle at top, #2c1a10 0%, #100d0a 85%);
        --panel: rgba(26, 20, 17, 0.78);
        --panel-hover: rgba(45, 34, 28, 0.45);
        --line: rgba(255, 255, 255, 0.08);
        --line-hover: rgba(255, 255, 255, 0.16);
        --text: #faf6f0;
        --muted: #aa9f96;
        --accent: #f97316;
        --accent-hover: #ea580c;
        --accent-soft: rgba(249, 115, 22, 0.12);
        --good: #10b981;
        --good-soft: rgba(16, 185, 129, 0.12);
        --warn: #f59e0b;
        --warn-soft: rgba(245, 158, 11, 0.12);
        --bad: #ef4444;
        --bad-soft: rgba(239, 68, 68, 0.12);
        --shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.7);
        --card-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      }

      :root[data-theme="light"] {
        --bg: #fafaf9;
        --bg-gradient: radial-gradient(circle at top, #ffedd5 0%, #fafaf9 85%);
        --panel: rgba(255, 255, 255, 0.85);
        --panel-hover: rgba(254, 243, 199, 0.4);
        --line: rgba(0, 0, 0, 0.06);
        --line-hover: rgba(0, 0, 0, 0.12);
        --text: #1c1917;
        --muted: #78716c;
        --accent: #ea580c;
        --accent-hover: #c2410c;
        --accent-soft: rgba(234, 88, 12, 0.08);
        --good: #059669;
        --good-soft: rgba(5, 150, 105, 0.1);
        --warn: #d97706;
        --warn-soft: rgba(217, 119, 6, 0.1);
        --bad: #dc2626;
        --bad-soft: rgba(220, 38, 38, 0.1);
        --shadow: 0 10px 30px -10px rgba(79, 70, 229, 0.1);
        --card-shadow: 0 4px 20px rgba(0, 0, 0, 0.05);
      }

      * { 
        box-sizing: border-box; 
      }

      body {
        margin: 0;
        font-family: 'Outfit', system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: var(--text);
        background: var(--bg);
        background-image: var(--bg-gradient);
        background-attachment: fixed;
        min-height: 100vh;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        transition: background 0.3s ease, color 0.3s ease;
      }

      /* Premium Header style */
      header {
        padding: 32px 24px 24px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--line);
        background: transparent;
      }
      .header-title-area {
        display: flex;
        flex-direction: column;
      }
      header h1 {
        margin: 0;
        font-size: 28px;
        font-weight: 700;
        background: linear-gradient(135deg, var(--text) 0%, var(--accent) 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        text-wrap: balance;
      }
      .subtitle {
        color: var(--muted);
        margin-top: 6px;
        font-size: 14px;
      }

      main {
        padding: 24px;
        display: grid;
        gap: 24px;
        max-width: 1400px;
        margin: 0 auto;
        width: 100%;
      }

      /* Glassmorphism Cards */
      section {
        background: var(--panel);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: var(--card-shadow);
        padding: 24px;
        transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.2s ease, border-color 0.2s ease;
      }
      section:hover {
        border-color: var(--line-hover);
        box-shadow: var(--shadow);
        transform: translateY(-2px);
      }

      .section-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 20px;
        border-bottom: 1px solid var(--line);
        padding-bottom: 12px;
      }
      .section-title h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        letter-spacing: -0.01em;
        text-wrap: balance;
      }
      .section-title .meta {
        color: var(--muted);
        font-size: 12px;
        font-family: 'JetBrains Mono', monospace;
      }

      .grid {
        display: grid;
        gap: 16px;
      }
      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        gap: 16px;
      }

      /* Premium Stat Cards */
      .stat {
        border: 1px solid var(--line);
        border-radius: 12px;
        padding: 16px;
        background: rgba(255, 255, 255, 0.02);
        backdrop-filter: blur(4px);
        transition: all 0.2s ease;
      }
      .stat:hover {
        background: rgba(255, 255, 255, 0.04);
        border-color: var(--line-hover);
      }
      .stat .label {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-weight: 500;
      }
      .stat .value {
        font-size: 14px;
        font-weight: 600;
        word-break: break-all;
      }

      /* Glowing Badges */
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        border-radius: 8px;
        padding: 4px 10px;
        font-size: 12px;
        font-weight: 500;
        border: 1px solid transparent;
        white-space: nowrap;
      }
      .badge.good { 
        color: #10b981; 
        background: var(--good-soft); 
        border-color: rgba(16, 185, 129, 0.2); 
      }
      .badge.warn { 
        color: #f59e0b; 
        background: var(--warn-soft); 
        border-color: rgba(245, 158, 11, 0.2); 
      }
      .badge.bad { 
        color: #ef4444; 
        background: var(--bad-soft); 
        border-color: rgba(239, 68, 68, 0.2); 
      }
      .badge.neutral { 
        color: var(--muted); 
        background: rgba(255, 255, 255, 0.05); 
        border-color: var(--line); 
      }

      /* Premium Tables */
      .stack {
        display: grid;
        gap: 12px;
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
      }
      th, td {
        padding: 14px 16px;
        text-align: left;
        vertical-align: middle;
      }
      th {
        color: var(--muted);
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        border-bottom: 1px solid var(--line);
        background: rgba(0, 0, 0, 0.05);
      }
      td {
        border-bottom: 1px solid var(--line);
      }
      tr {
        transition: background-color 0.2s ease;
      }
      tr:hover {
        background-color: var(--panel-hover);
      }
      tr.row-active {
        background-color: var(--accent-soft);
      }
      tr:last-child td {
        border-bottom: none;
      }

      .mono {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 12px;
      }
      .tabular-nums {
        font-variant-numeric: tabular-nums;
      }
      .muted { color: var(--muted); }
      .row-highlight {
        background: rgba(255, 255, 255, 0.03);
      }

      /* Custom Fields & Inputs */
      .field {
        width: 100%;
        min-width: 92px;
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: rgba(0, 0, 0, 0.1);
        color: var(--text);
        font-family: inherit;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .field:hover {
        border-color: var(--line-hover);
      }
      .field:focus, .field:focus-visible {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      .field.inline {
        max-width: 180px;
      }

      /* Action Toolbar & Buttons */
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        align-items: flex-end;
      }
      .toolbar label {
        display: grid;
        gap: 6px;
        font-size: 12px;
        color: var(--muted);
        font-weight: 500;
      }
      .toolbar .wide {
        min-width: 320px;
        flex: 1 1 340px;
      }
      .toolbar .narrow {
        width: 140px;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.03);
        color: var(--text);
        border-radius: 8px;
        padding: 8px 14px;
        cursor: pointer;
        font: inherit;
        font-weight: 500;
        font-size: 13px;
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      }
      button:hover {
        background: var(--panel-hover);
        border-color: var(--line-hover);
        transform: translateY(-1px);
      }
      button:active {
        transform: translateY(0) scale(0.98);
      }
      button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
      }
      button.primary {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
        box-shadow: 0 4px 12px rgba(99, 102, 241, 0.15);
      }
      button.primary:hover {
        background: var(--accent-hover);
        border-color: var(--accent-hover);
        box-shadow: 0 6px 16px rgba(99, 102, 241, 0.25);
      }
      button.danger {
        background: var(--bad-soft);
        border-color: rgba(239, 68, 68, 0.2);
        color: #ef4444;
      }
      button.danger:hover {
        background: #ef4444;
        border-color: #ef4444;
        color: white;
      }
      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none !important;
        box-shadow: none !important;
      }

      /* Mac Terminal Style for Logs & Pre */
      .terminal-window {
        background: #0d1117;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 12px;
        overflow: hidden;
        box-shadow: var(--card-shadow);
      }
      .terminal-header {
        background: #161b22;
        padding: 8px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      }
      .terminal-dots {
        display: flex;
        gap: 6px;
      }
      .terminal-dot {
        width: 10px;
        height: 10px;
        border-radius: 50%;
      }
      .terminal-dot.red { background: #ff5f56; }
      .terminal-dot.yellow { background: #ffbd2e; }
      .terminal-dot.green { background: #27c93f; }
      .terminal-title {
        color: #8b949e;
        font-size: 11px;
        font-family: 'JetBrains Mono', monospace;
      }
      pre.log {
        background: #0d1117;
        border: none;
        border-radius: 0;
        margin: 0;
        color: #c9d1d9;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 13px;
        line-height: 1.6;
        padding: 16px;
        max-height: 250px;
        overflow-y: auto;
      }

      /* Error Alert Box */
      .error-list {
        margin: 0;
        padding-left: 20px;
        color: #ef4444;
      }
      
      /* Form Columns */
      .form-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 24px;
      }
      .form-column {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .form-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .form-group label {
        font-size: 12px;
        font-weight: 600;
        color: var(--muted);
      }
      .form-row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      textarea.field {
        resize: vertical;
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 12px;
      }
      h3 {
        margin: 0 0 4px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
        border-bottom: 1px solid var(--line);
        padding-bottom: 8px;
      }

      /* Theme toggle button */
      .theme-toggle-btn {
        width: 36px;
        height: 36px;
        border-radius: 50%;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid var(--line);
        color: var(--text);
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .theme-toggle-btn:hover {
        transform: rotate(12deg) translateY(-1px);
        background: var(--panel-hover);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }

      /* Models List & Chips */
      .model-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .model-chip {
        display: inline-flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        max-width: 240px;
        min-width: 160px;
        padding: 8px 12px;
        text-align: left;
        white-space: normal;
        word-break: break-all;
        background: rgba(255, 255, 255, 0.02);
      }
      .model-chip.active {
        background: var(--accent-soft);
        border-color: var(--accent);
        box-shadow: 0 0 0 1px var(--accent);
      }
      .model-chip .mono {
        display: block;
        max-width: 100%;
        font-weight: 500;
      }
      .model-chip .meta {
        font-size: 10px;
        line-height: 1.2;
      }
      .statusline {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .statusline .message {
        color: var(--muted);
      }
      .small {
        font-size: 12px;
      }

      /* Status pulse keyframes */
      .status-pulse-container {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      @media (max-width: 860px) {
        main { padding: 16px; }
        header { padding: 24px 16px 16px; }
        .toolbar .wide, .toolbar .narrow { width: 100%; min-width: 0; }
        .form-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="header-title-area">
        <h1>Cliproxy Dashboard</h1>
        <div class="subtitle">Local account priority, routing config, and recent selector logs.</div>
      </div>
      <button id="theme-toggle" class="theme-toggle-btn" aria-label="Toggle Theme" type="button">
        <!-- Theme icon will be injected by JavaScript -->
      </button>
    </header>
    <main>
      <section>
        <div class="section-title">
          <h2>Accounts</h2>
          <div class="meta" style="display: flex; gap: 8px; align-items: center;">
            <span class="badge neutral" id="account-count"></span>
            <span class="badge neutral" id="selected-account"></span>
            <button type="button" id="verify-all-btn" class="small" style="padding: 2px 8px; font-size: 12px;">Verify All</button>
          </div>
        </div>
        <div class="stack">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Account</th>
                <th>Priority</th>
                <th>Note</th>
                <th>Status</th>
                <th>Timing</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="accounts"></tbody>
          </table>
        </div>
      </section>

      <section id="rate-limits-section" style="display: none;">
        <div class="section-title">
          <h2>Rate Limit Resets</h2>
          <div class="meta" id="rate-limits-meta"></div>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 16px; border: 1px solid var(--warn); border-radius: 12px; background: var(--warn-soft);">
          <div>
            <div style="font-weight: 600; font-size: 16px; color: var(--warn);">Rate limit reset is available!</div>
            <div style="font-size: 14px; color: var(--muted); margin-top: 4px;">You have <span id="reset-credits-count" style="font-weight: 700;">0</span> rate limit reset(s) banked in your Codex account.</div>
          </div>
            <button type="button" id="redeem-reset-btn" class="primary" disabled title="Reset-credit redemption is outside the retained snapshot story." style="background: var(--warn); border-color: var(--warn); color: #000; font-weight: 600; padding: 10px 20px; opacity: .55; cursor: not-allowed;">Redemption disabled</button>
        </div>
      </section>

      <section>
        <div class="section-title">
          <h2>Overview</h2>
          <div class="meta" id="refresh-meta"></div>
        </div>
        <div class="summary" id="summary"></div>
      </section>

      <section>
        <div class="section-title">
          <h2>Routing</h2>
          <div class="meta">Changes write back to <span class="mono" id="config-path"></span></div>
        </div>
        <div class="toolbar">
          <label class="wide">
            Strategy
            <select id="routing-strategy" class="field">
              <option value="fill-first">fill-first</option>
              <option value="failover">failover</option>
            </select>
          </label>
          <label class="narrow">
            <span>Session affinity</span>
            <input id="session-affinity" type="checkbox" />
          </label>
          <div class="actions">
            <button id="save-routing" class="primary" type="button">Save routing</button>
          </div>
        </div>
      </section>

      <section>
        <div class="section-title">
          <h2>Add Codex Account</h2>
          <div class="meta">Authenticate a new account or import an existing credentials file.</div>
        </div>
        <div class="form-grid">
          <div class="form-column">
            <h3>🔑 Browser Authentication</h3>
            <div style="padding: 24px; border: 1px solid var(--line); border-radius: 12px; background: rgba(0, 0, 0, 0.08); height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 16px; min-height: 200px;">
              <button type="button" id="trigger-oauth-btn" class="primary" style="background: var(--good); border-color: var(--good); display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; width: 100%;">
                <span>🔑</span> Login via Browser (OAuth)
              </button>
              <div style="font-size: 12px; color: var(--muted); text-align: center; line-height: 1.5;">
                Opens a new browser tab to authenticate your Codex account via Google/OpenAI.
                The account will appear here automatically once completed.
              </div>
            </div>
          </div>
          <div class="form-column">
            <h3>📥 Import from JSON</h3>
            <div class="form-column" style="height: 100%;">
              <div class="form-group" style="flex: 1; min-height: 140px;">
                <label for="paste-json-area">Paste Codex credentials JSON file</label>
                <textarea id="paste-json-area" class="field" style="height: 100%; min-height: 120px;" placeholder='{&#10;  "email": "user@example.com",&#10;  "access_token": "…",&#10;  …&#10;}' spellcheck="false" autocomplete="off"></textarea>
              </div>
              <div class="actions" style="margin-top: auto; padding-top: 12px;">
                <button type="button" id="import-json-btn" class="primary" style="width: 100%;">Import Account JSON</button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="section-title">
          <h2>Test request</h2>
          <div class="meta">Uses the current proxy config and inbound key.</div>
        </div>
        <div class="toolbar">
          <label class="wide">
            Prompt
            <input id="test-prompt" class="field" value="${DEFAULT_TEST_PROMPT}" />
          </label>
          <label class="narrow">
            Model
            <input id="test-model" class="field" value="${DEFAULT_TEST_MODEL}" />
          </label>
          <label class="narrow">
            Max tokens
            <input id="test-tokens" class="field" type="number" min="1" step="1" value="${DEFAULT_TEST_OUTPUT_TOKENS}" />
          </label>
          <div class="actions">
            <button id="send-test" class="primary" type="button">Send test request</button>
          </div>
        </div>
        <div class="stack">
          <div class="statusline small">
            <span class="badge neutral" id="model-count">0 models</span>
          </div>
          <div class="model-list" id="model-list"></div>
          <div class="statusline">
            <span class="badge neutral" id="test-status">idle</span>
            <span class="message" id="test-message"></span>
          </div>
          <div class="terminal-window">
            <div class="terminal-header">
              <div class="terminal-dots">
                <span class="terminal-dot red"></span>
                <span class="terminal-dot yellow"></span>
                <span class="terminal-dot green"></span>
              </div>
              <div class="terminal-title">test-output.json</div>
            </div>
            <pre class="log" id="test-output" style="max-height: 300px; overflow-y: auto; border-radius: 0;"></pre>
          </div>
        </div>
      </section>

      <section>
        <div class="section-title">
          <h2>Selector log</h2>
          <div class="meta">Newest Codex selection is highlighted here.</div>
        </div>
        <div class="terminal-window">
          <div class="terminal-header">
            <div class="terminal-dots">
              <span class="terminal-dot red"></span>
              <span class="terminal-dot yellow"></span>
              <span class="terminal-dot green"></span>
            </div>
            <div class="terminal-title">selector.log</div>
          </div>
          <div class="terminal-body" id="selector-log"></div>
        </div>
      </section>

      <section>
        <div class="section-title">
          <h2>Request log</h2>
          <div class="meta">Latest proxy requests from the service log.</div>
        </div>
        <div class="terminal-window">
          <div class="terminal-header">
            <div class="terminal-dots">
              <span class="terminal-dot red"></span>
              <span class="terminal-dot yellow"></span>
              <span class="terminal-dot green"></span>
            </div>
            <div class="terminal-title">request.log</div>
          </div>
          <div class="terminal-body" id="request-log"></div>
        </div>
      </section>

      <section>
        <div class="section-title">
          <h2>Errors</h2>
          <div class="meta">Read-only diagnostics from the local files.</div>
        </div>
        <ul class="error-list" id="errors"></ul>
      </section>
      </main>
  
      <script type="module">
        const OPERATOR_TOKEN = ${JSON.stringify(operatorToken)};
        const state = {
          data: null,
          rateLimits: null,
        busy: false,
        refreshTimer: null,
      };

      const els = {
        refreshMeta: document.getElementById("refresh-meta"),
        summary: document.getElementById("summary"),
        configPath: document.getElementById("config-path"),
        routingStrategy: document.getElementById("routing-strategy"),
        sessionAffinity: document.getElementById("session-affinity"),
        saveRouting: document.getElementById("save-routing"),
        accounts: document.getElementById("accounts"),
        accountCount: document.getElementById("account-count"),
        selectedAccount: document.getElementById("selected-account"),
        selectorLog: document.getElementById("selector-log"),
        requestLog: document.getElementById("request-log"),
        errors: document.getElementById("errors"),
        testPrompt: document.getElementById("test-prompt"),
        testModel: document.getElementById("test-model"),
        testTokens: document.getElementById("test-tokens"),
        modelCount: document.getElementById("model-count"),
        modelList: document.getElementById("model-list"),
        sendTest: document.getElementById("send-test"),
        testStatus: document.getElementById("test-status"),
        testMessage: document.getElementById("test-message"),
        testOutput: document.getElementById("test-output"),
        pasteJsonArea: document.getElementById("paste-json-area"),
        importJsonBtn: document.getElementById("import-json-btn"),
        triggerOauthBtn: document.getElementById("trigger-oauth-btn"),
        verifyAllBtn: document.getElementById("verify-all-btn"),
      };

      function escapeHtml(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;");
      }

      function badgeClass(kind) {
        return kind === "good" || kind === "warn" || kind === "bad" ? kind : "neutral";
      }

      function formatValue(value, fallback = "—") {
        return value === null || value === undefined || value === "" ? fallback : value;
      }

      function formatToGmt7(dateInput) {
        if (!dateInput || dateInput === "—" || dateInput === "\u2014") return "—";
        try {
          const d = new Date(dateInput);
          if (isNaN(d.getTime())) return String(dateInput);
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Bangkok",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false
          });
          const parts = formatter.formatToParts(d);
          const year = parts.find(p => p.type === 'year')?.value;
          const month = parts.find(p => p.type === 'month')?.value;
          const day = parts.find(p => p.type === 'day')?.value;
          const hour = parts.find(p => p.type === 'hour')?.value;
          const minute = parts.find(p => p.type === 'minute')?.value;
          const second = parts.find(p => p.type === 'second')?.value;
          return \`\${year}-\${month}-\${day} \${hour}:\${minute}:\${second}\`;
        } catch {
          return String(dateInput);
        }
      }

      function formatDateGmt7(dateInput) {
        if (!dateInput || dateInput === "—" || dateInput === "\u2014") return "—";
        try {
          const d = new Date(dateInput);
          if (isNaN(d.getTime())) return String(dateInput);
          const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: "Asia/Bangkok",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
          });
          const parts = formatter.formatToParts(d);
          const year = parts.find(p => p.type === 'year')?.value;
          const month = parts.find(p => p.type === 'month')?.value;
          const day = parts.find(p => p.type === 'day')?.value;
          return \`\${year}-\${month}-\${day}\`;
        } catch {
          return String(dateInput);
        }
      }

      function selectedAuthName() {
        return state.data?.selectedAccount?.email ?? state.data?.logSummary?.latestCodexSelection?.auth ?? "none";
      }

      function renderModels() {
        const data = state.data;
        if (!data) {
          return;
        }
        const currentModel = els.testModel.value.trim();
        els.modelCount.textContent =
          data.models.length + " model" + (data.models.length === 1 ? "" : "s");
        els.modelList.innerHTML = data.models.length
          ? data.models
              .map((model) => {
                const active = model.id === currentModel;
                return [
                  '<button type="button" class="model-chip ' + (active ? "active" : "") + '"',
                  ' data-model-id="' + escapeHtml(model.id) + '"',
                  ' title="' + escapeHtml(model.ownedBy || "unknown") + '">',
                  '<span class="mono">' + escapeHtml(model.id) + "</span>",
                  '<span class="muted meta">' + escapeHtml(model.ownedBy || "unknown") + "</span>",
                  "</button>",
                ].join("");
              })
              .join("")
          : '<div class="muted small">No models were returned by /v1/models.</div>';
      }

      function renderSummary() {
        const data = state.data;
        if (!data) {
          return;
        }
        const config = data.config;
        const selection = data.logSummary.latestCodexSelection;
        const latestRequest = data.logSummary.latestRequest;
        els.summary.innerHTML = [
          {
            label: "Proxy config",
            value: config ? config.path : data.paths.configPath,
            badge: config ? "good" : "warn",
          },
          {
            label: "Routing",
            value: config ? \`\${config.routingStrategy} / session-affinity \${config.sessionAffinity ? "on" : "off"}\` : "unknown",
            badge: config ? "good" : "warn",
          },
          {
            label: "Auth dir",
            value: data.paths.authDir,
            badge: "neutral",
          },
          {
            label: "Proxy URL",
            value: data.paths.proxyUrl,
            badge: "neutral",
          },
          {
            label: "Latest Codex auth",
            value: selection ? selection.auth : "none",
            badge: selection ? "good" : "warn",
          },
          {
            label: "Latest request",
            value: latestRequest ? \`\${latestRequest.status} \${latestRequest.method} \${latestRequest.path}\` : "none",
            badge: latestRequest ? "good" : "warn",
          },
        ]
          .map(
            (item) => \`
              <div class="stat">
                <div class="label">\${escapeHtml(item.label)} <span class="badge \${badgeClass(item.badge)}">\${escapeHtml(item.badge)}</span></div>
                <div class="value mono">\${escapeHtml(formatValue(item.value))}</div>
              </div>
            \`,
          )
          .join("");
        els.refreshMeta.textContent = "last refresh " + formatToGmt7(data.lastRefreshedAt);
        els.configPath.textContent = data.paths.configPath;
        if (config) {
          els.routingStrategy.value = config.routingStrategy;
          els.sessionAffinity.checked = Boolean(config.sessionAffinity);
        }
        els.accountCount.textContent = \`\${data.accounts.length} accounts\`;
        els.selectedAccount.textContent = \`selected \${selectedAuthName()}\`;
        els.errors.innerHTML = data.errors.map((error) => \`<li>\${escapeHtml(error)}</li>\`).join("");
      }

      function renderAccounts() {
        const data = state.data;
        if (!data) {
          return;
        }
        const selectedFile = data.logSummary.latestCodexSelection?.auth ?? "";
        els.accounts.innerHTML = data.accounts
          .map((account, index) => {
            const selected = selectedFile === account.fileName;
            const priorityValue = account.explicitPriority ? String(account.priority) : "";

            let statusBadge = '<div class="status-pulse-container" style="margin-top: 6px;"><span class="status-pulse neutral"></span><div class="badge neutral">Unverified</div></div>';
            if (account.validityStatus === "valid") {
              statusBadge = '<div class="status-pulse-container" style="margin-top: 6px;"><span class="status-pulse good"></span><div class="badge good">Valid</div></div>';
            } else if (account.validityStatus === "invalid") {
              const tooltip = escapeHtml(account.validationError || "Session has ended");
              statusBadge = '<div class="status-pulse-container" style="margin-top: 6px;"><span class="status-pulse bad"></span><div class="badge bad" title="' + tooltip + '">Session ended</div></div>';
            }

              const quota = account.quota || {};
              const primary5h = quota.primary5h || { status: "unknown" };
              const weekly = quota.weekly || { status: "unknown" };
              const nowMs = Date.now();

              const barColor = (pct) => pct >= 90 ? "var(--bad)" : pct >= 70 ? "var(--warn)" : "var(--good)";
              const statusColor = (status) => {
                if (status === "current") return "var(--good)";
                if (status === "blocked") return "var(--bad)";
                if (status === "unknown") return "var(--fg-muted,#888)";
                return "var(--warn)";
              };
              const fmtReset = (resetAt) => {
                const resetMs = resetAt ? Date.parse(resetAt) : NaN;
                if (!Number.isFinite(resetMs)) return "";
                if (nowMs > resetMs) return "Reset passed";
                const d = new Date(resetMs);
                return "Resets " + d.toLocaleString("en-US", { timeZone: "Asia/Bangkok", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
              };
            const fmtAge = (ms) => {
              if (ms < 0) return "";
              const mins = Math.round((nowMs - ms) / 60000);
              if (mins < 1) return "just now";
              if (mins < 60) return mins + "m ago";
              const hrs = Math.round(mins / 60);
                if (hrs < 24) return hrs + "h ago";
                return Math.round(hrs / 24) + "d ago";
              };
              const mkBar = (label, windowQuota) => {
                const pct = typeof windowQuota.usedPercent === "number" ? windowQuota.usedPercent : -1;
                const status = windowQuota.status || "unknown";
                if (pct < 0) {
                  return '<div style="min-width:130px;"><div style="font-size:10px;color:var(--fg-muted,#888);margin-bottom:2px;">' + label + '</div><div style="color:#555;font-size:12px;">Unknown</div><div style="font-size:10px;color:' + statusColor(status) + ';">' + escapeHtml(status) + '</div></div>';
                }
                const rem = (100 - pct) + "%";
                const color = barColor(pct);
                const fillPct = Math.max(0, 100 - pct);
                const resetStr = fmtReset(windowQuota.resetAt);
                const observedMs = windowQuota.observedAt ? Date.parse(windowQuota.observedAt) : NaN;
                const observedStr = Number.isFinite(observedMs) ? "Observed " + fmtAge(observedMs) : "";
                const remainingLabel = status === "current" ? rem + " remaining" : rem + " latest known";
                return '<div style="min-width:130px;">' +
                  '<div style="font-size:10px;color:var(--fg-muted,#888);margin-bottom:2px;">' + label + '</div>' +
                  '<div style="font-weight:700;font-size:13px;color:' + color + ';">' + remainingLabel + '</div>' +
                  '<div style="margin:4px 0;height:5px;border-radius:3px;background:rgba(255,255,255,0.08);overflow:hidden;">' +
                    '<div style="height:100%;width:' + fillPct + '%;background:' + color + ';border-radius:3px;transition:width .3s;"></div>' +
                  '</div>' +
                  '<div style="font-size:10px;color:' + statusColor(status) + ';">' + escapeHtml(status) + '</div>' +
                  (resetStr ? '<div style="font-size:10px;color:var(--fg-muted,#888);">' + resetStr + '</div>' : "") +
                  (observedStr ? '<div style="font-size:10px;color:var(--fg-muted,#888);">' + observedStr + '</div>' : "") +
                '</div>';
              };
              const quotaCell = '<div style="display:flex;flex-direction:column;gap:10px;">' +
                  mkBar("5 hour usage limit", primary5h) +
                  mkBar("Weekly usage limit", weekly) +
                '</div>';

            const showReauth = account.validityStatus === "invalid";
            const reauthBtn = showReauth ? '<button type="button" data-action="reauth" style="flex:1;font-size:11px;padding:4px 6px;background:var(--warn-soft);border-color:rgba(245,158,11,0.2);color:var(--warn);">⟳ Reauth</button>' : "";

            const isExpired = account.expired ? new Date(account.expired) < new Date() : false;
            const expiryStyle = isExpired ? "color: var(--bad); font-weight: bold;" : "";
            const expiryText = isExpired
              ? escapeHtml(formatToGmt7(account.expired)) + " (Expired)"
              : escapeHtml(account.expired ? formatToGmt7(account.expired) : "—");

              const planDisplay = account.subscriptionPlan || account.plan || "free";
            const planBadge = planDisplay.toLowerCase() === "plus"
              ? '<span class="badge warn" style="margin-left: 6px; font-size: 10px; padding: 2px 6px; background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(249, 115, 22, 0.2)); border-color: rgba(245, 158, 11, 0.4); color: var(--warn); font-weight: 600; text-transform: uppercase;">Plus</span>'
              : '<span class="badge neutral" style="margin-left: 6px; font-size: 10px; padding: 2px 6px; text-transform: uppercase;">Free</span>';

              const isSubExpired = account.subscriptionActiveUntil ? new Date(account.subscriptionActiveUntil) < new Date() : false;
              const subExpiryStyle = isSubExpired ? "color: var(--bad); font-weight: bold;" : "";
              const subExpiryText = isSubExpired
                ? escapeHtml(formatDateGmt7(account.subscriptionActiveUntil)) + " (Expired)"
                : (account.subscriptionActiveUntil ? escapeHtml(formatDateGmt7(account.subscriptionActiveUntil)) : "—");

            return \`
              <tr class="\${selected ? "row-active" : ""}" data-file="\${escapeHtml(account.fileName)}">
                <td class="mono tabular-nums">\${index + 1}</td>
                <td>
                  <div style="display: flex; align-items: center; gap: 4px;"><strong>\${escapeHtml(account.email)}</strong>\${planBadge}</div>
                  <div class="muted mono">\${escapeHtml(account.fileName)}</div>
                  <div class="muted small mono">\${escapeHtml(account.accountIdShort || "—")} \${escapeHtml(account.type || "")}</div>
                </td>
                <td style="min-width: 120px;">
                  <input class="field inline mono tabular-nums" data-field="priority" value="\${escapeHtml(priorityValue)}" placeholder="\${account.priority}" />
                  <div class="muted small">\${account.explicitPriority ? "explicit" : "default"} \${account.disabled ? "disabled" : "enabled"}</div>
                </td>
                <td style="min-width: 140px;">
                  <input class="field inline" data-field="note" value="\${escapeHtml(account.note)}" placeholder="note" />
                </td>
                <td>
                  <label class="small"><input type="checkbox" data-field="disabled" \${account.disabled ? "checked" : ""} /> disabled</label>
                  \${statusBadge}
                </td>
                <td style="min-width: 90px;">
                  \${quotaCell}
                </td>
                <td class="mono small tabular-nums">
                  <div title="Last refresh"><span class="muted">Ref:</span> \${escapeHtml(account.lastRefresh ? formatToGmt7(account.lastRefresh) : "\u2014")}</div>
                  <div title="OAuth Session Expires at" style="\${expiryStyle}"><span class="muted">Exp:</span> \${expiryText}</div>
                  <div title="ChatGPT Subscription active until" style="\${subExpiryStyle}"><span class="muted">Sub:</span> \${subExpiryText}</div>
                </td>
                <td>
                  <div style="display:flex;flex-direction:column;gap:5px;min-width:130px;">
                    <div style="display:flex;gap:4px;flex-wrap:wrap;">
                      <button type="button" data-action="verify" title="Verify token" style="flex:1;min-width:52px;background:rgba(99,102,241,0.12);border-color:rgba(99,102,241,0.25);color:var(--accent);font-size:11px;padding:4px 6px;">✓ Verify</button>
                      <button type="button" data-action="primary" title="Set as primary" style="flex:1;min-width:52px;font-size:11px;padding:4px 6px;background:rgba(245,158,11,0.15);border-color:rgba(245,158,11,0.3);color:var(--warn);font-weight:600;">★ Primary</button>
                    </div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap;">
                      <button type="button" data-action="save" title="Save priority/note changes" style="flex:1;min-width:40px;font-size:11px;padding:4px 6px;">Save</button>
                      <button type="button" data-action="toggle" title="\${account.disabled ? 'Enable this account' : 'Disable this account'}" style="flex:1;min-width:40px;font-size:11px;padding:4px 6px;\${account.disabled ? 'background:rgba(99,102,241,0.15);color:var(--accent);' : ''}">\${account.disabled ? "Enable" : "Disable"}</button>
                    </div>
                    <div style="display:flex;gap:4px;flex-wrap:wrap;">
                      \${reauthBtn}
                      <button type="button" data-action="backup" title="Set as low-priority backup" style="flex:1;font-size:11px;padding:4px 6px;">Backup</button>
                      <button type="button" data-action="clear" title="Remove explicit priority" style="flex:1;font-size:11px;padding:4px 6px;">Clear ★</button>
                    </div>
                    <div style="display:flex;gap:4px;margin-top:2px;border-top:1px solid rgba(255,255,255,0.06);padding-top:5px;">
                      <button type="button" data-action="delete" title="Permanently delete this profile" style="flex:1;font-size:11px;padding:4px 6px;background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.25);color:#f87171;">🗑 Delete</button>
                    </div>
                  </div>
                </td>
              </tr>
            \`;
          })
          .join("");
      }

      function renderLogs() {
        const data = state.data;
        if (!data) {
          return;
        }
        const selections = data.logSummary.recentSelections;
        const requests = data.logSummary.recentRequests;
        const selectedFile = data.logSummary.latestCodexSelection?.auth ?? "";
        els.selectorLog.innerHTML = selections.length
          ? selections
              .map(
                (item) => \`
                  <pre class="log \${item.auth === selectedFile ? "row-highlight" : ""}">\${escapeHtml(item.raw)}</pre>
                \`,
              )
              .join("")
          : '<div class="muted">No selector lines found in the tail of main.log.</div>';
        els.requestLog.innerHTML = requests.length
          ? requests.map((item) => \`<pre class="log">\${escapeHtml(item.raw)}</pre>\`).join("")
          : '<div class="muted">No request lines found in the tail of main.log.</div>';
      }

      function renderRateLimits() {
        const rl = state.rateLimits;
        const section = document.getElementById("rate-limits-section");
        if (!rl || !rl.ok || rl.availableCount <= 0) {
          section.style.display = "none";
          return;
        }
        section.style.display = "block";
        document.getElementById("reset-credits-count").textContent = rl.availableCount;
      }

      function render() {
        renderSummary();
        renderAccounts();
        renderModels();
        renderLogs();
        renderRateLimits();
      }

      function setTestStatus(kind, message) {
        els.testStatus.className = \`badge \${badgeClass(kind)}\`;
        els.testStatus.textContent = kind;
        els.testMessage.textContent = message;
      }

      async function refresh() {
        if (state.busy) {
          return;
        }
        const active = document.activeElement;
        if (active && (active.tagName === "INPUT" || active.tagName === "SELECT" || active.tagName === "TEXTAREA")) {
          if (els.accounts.contains(active) || active.id === "routing-strategy" || active.id === "session-affinity") {
            return;
          }
        }
        state.busy = true;
        try {
          const response = await fetch("/api/state", { cache: "no-store" });
          if (!response.ok) {
            throw new Error(\`state request failed: \${response.status}\`);
          }
          state.data = await response.json();

          try {
              const rlResponse = await fetch("/api/codex/rate-limits", {
                cache: "no-store",
                headers: { "${DASHBOARD_OPERATOR_TOKEN_HEADER}": OPERATOR_TOKEN },
              });
            if (rlResponse.ok) {
              state.rateLimits = await rlResponse.json();
            } else {
              state.rateLimits = null;
            }
          } catch (rlErr) {
            state.rateLimits = null;
          }

          render();
        } catch (error) {
          setTestStatus("bad", error instanceof Error ? error.message : String(error));
        } finally {
          state.busy = false;
        }
      }

      async function postJson(url, payload) {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "${DASHBOARD_OPERATOR_TOKEN_HEADER}": OPERATOR_TOKEN,
            },
            body: JSON.stringify(payload),
          });
        const text = await response.text();
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          parsed = { raw: text };
        }
        if (!response.ok) {
          const detail = parsed && typeof parsed === "object" && parsed.error ? parsed.error : text;
          throw new Error(detail || \`request failed: \${response.status}\`);
        }
        return parsed;
      }

      els.accounts.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) {
          return;
        }
        const row = button.closest("tr[data-file]");
        if (!row) {
          return;
        }
        const fileName = row.getAttribute("data-file");
        const action = button.getAttribute("data-action");
        const priorityField = row.querySelector('[data-field="priority"]');
        const noteField = row.querySelector('[data-field="note"]');
        const disabledField = row.querySelector('[data-field="disabled"]');
        const payload = {
          priority: priorityField && priorityField.value.trim() !== "" ? Number(priorityField.value) : null,
          note: noteField ? noteField.value : null,
          disabled: disabledField ? Boolean(disabledField.checked) : null,
        };
        try {
          setTestStatus("neutral", \`updating \${fileName}…\`);
          if (action === "reauth") {
            const email = row.querySelector("strong")?.textContent || "";
            setTestStatus("neutral", \`Triggering OAuth login…\`);
            const result = await postJson("/api/accounts/login-oauth", { email });
            if (result.url) {
              window.open(result.url, "_blank");
            }
            setTestStatus("good", \`Reauthentication triggered! Please login as \${email} in the browser.\`);
          } else if (action === "verify") {
            setTestStatus("neutral", \`verifying \${fileName}…\`);
            const result = await postJson(\`/api/accounts/\${encodeURIComponent(fileName)}/verify\`, {});
            if (result.valid) {
              setTestStatus("good", \`\${fileName} is valid\${result.refreshed ? " (refreshed)" : ""}\`);
            } else {
              setTestStatus("warn", \`\${fileName} is invalid: \${result.error || "unknown error"}\`);
            }
          } else if (action === "save") {
            await postJson(\`/api/accounts/\${encodeURIComponent(fileName)}\`, payload);
          } else if (action === "primary") {
            await postJson(\`/api/accounts/\${encodeURIComponent(fileName)}/primary\`, {});
          } else if (action === "backup") {
            await postJson(\`/api/accounts/\${encodeURIComponent(fileName)}/backup\`, {});
          } else if (action === "clear") {
            await postJson(\`/api/accounts/\${encodeURIComponent(fileName)}/clear-priority\`, {});
          } else if (action === "toggle") {
            await postJson(\`/api/accounts/\${encodeURIComponent(fileName)}\`, {
              disabled: !(disabledField && disabledField.checked),
            });
          } else if (action === "delete") {
            const email = row.querySelector("strong")?.textContent || fileName;
            const confirmed = window.confirm(\`Delete "\${email}"?\\n\\nThe file will be backed up before removal. This cannot be undone from the dashboard.\`);
            if (!confirmed) {
              return;
            }
            setTestStatus("neutral", \`Deleting \${fileName}…\`);
              const response = await fetch(\`/api/accounts/\${encodeURIComponent(fileName)}\`, {
                method: "DELETE",
                headers: { "${DASHBOARD_OPERATOR_TOKEN_HEADER}": OPERATOR_TOKEN },
              });
            const result = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(result.error || \`Delete failed: \${response.status}\`);
            }
            setTestStatus("good", \`\${email} deleted successfully\`);
            await refresh();
            return;
          }
          await refresh();
          if (action !== "verify" && action !== "reauth") {
            setTestStatus("good", \`\${fileName} updated\`);
          }
        } catch (error) {
          setTestStatus("bad", error instanceof Error ? error.message : String(error));
        }
      });

      els.verifyAllBtn.addEventListener("click", async () => {
        const accounts = state.data?.accounts || [];
        if (!accounts.length) return;
        els.verifyAllBtn.disabled = true;
        const originalText = els.verifyAllBtn.textContent;
        try {
          for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            els.verifyAllBtn.textContent = \`Verifying \${i + 1}/\${accounts.length}…\`;
            setTestStatus("neutral", \`Verifying \${account.email}…\`);
            await postJson(\`/api/accounts/\${encodeURIComponent(account.fileName)}/verify\`, {});
          }
          setTestStatus("good", "All accounts verified successfully");
        } catch (error) {
          setTestStatus("bad", error instanceof Error ? error.message : String(error));
        } finally {
          els.verifyAllBtn.disabled = false;
          els.verifyAllBtn.textContent = originalText;
          await refresh();
        }
      });

      els.modelList.addEventListener("click", (event) => {
        const button = event.target.closest("button[data-model-id]");
        if (!button) {
          return;
        }
        const modelId = button.getAttribute("data-model-id");
        if (!modelId) {
          return;
        }
        els.testModel.value = modelId;
        renderModels();
      });

      els.testModel.addEventListener("input", () => {
        renderModels();
      });

      els.saveRouting.addEventListener("click", async () => {
        try {
          setTestStatus("neutral", "saving routing…");
          await postJson("/api/routing", {
            strategy: els.routingStrategy.value,
            sessionAffinity: els.sessionAffinity.checked,
          });
          await refresh();
          setTestStatus("good", "routing saved");
        } catch (error) {
          setTestStatus("bad", error instanceof Error ? error.message : String(error));
        }
      });

      els.sendTest.addEventListener("click", async () => {
        try {
          setTestStatus("neutral", "sending test request…");
          els.testOutput.textContent = "";
          const result = await postJson("/api/test-request", {
            prompt: els.testPrompt.value,
            model: els.testModel.value,
            maxOutputTokens: Number(els.testTokens.value),
          });
          setTestStatus(result.ok ? "good" : "warn", \`request \${result.requestId} -> \${result.status}\`);
          els.testOutput.textContent = [
            \`requestId: \${result.requestId}\`,
            \`status: \${result.status}\`,
            "",
            result.responseText || "",
            "",
            result.latestCodexSelection ? \`latest codex auth: \${result.latestCodexSelection.auth}\` : "latest codex auth: none",
          ].join("\\n");
          await refresh();
        } catch (error) {
          setTestStatus("bad", error instanceof Error ? error.message : String(error));
        }
      });

      els.importJsonBtn.addEventListener("click", async () => {
        try {
          const text = els.pasteJsonArea.value.trim();
          if (!text) {
            throw new Error("JSON area is empty");
          }
          const parsed = JSON.parse(text);
          if (typeof parsed !== "object" || parsed === null) {
            throw new Error("Invalid JSON: must be an object");
          }
          if (!parsed.email) {
            throw new Error("Pasted JSON must contain an 'email' field");
          }

          let plan = "free";
          if (parsed.plan) {
            plan = parsed.plan;
          } else if (parsed.fileName) {
            plan = inferPlan(parsed.fileName);
          } else {
            plan = parsed.plan_type || "free";
          }

          const payload = {
            email: parsed.email.trim(),
            plan: plan.trim(),
            priority: typeof parsed.priority === "number" ? parsed.priority : 100,
            note: typeof parsed.note === "string" ? parsed.note.trim() : "",
            account_id: typeof parsed.account_id === "string" ? parsed.account_id.trim() : "",
            access_token: typeof parsed.access_token === "string" ? parsed.access_token.trim() : "",
            id_token: typeof parsed.id_token === "string" ? parsed.id_token.trim() : "",
            refresh_token: typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim() : "",
            disabled: typeof parsed.disabled === "boolean" ? parsed.disabled : false,
            expired: typeof parsed.expired === "string" ? parsed.expired.trim() : "",
            last_refresh: typeof parsed.last_refresh === "string" ? parsed.last_refresh.trim() : "",
          };

          setTestStatus("neutral", "importing Codex account…");
          const result = await postJson("/api/accounts", payload);
          setTestStatus("good", \`Account \${result.account.email} imported successfully\`);
          els.pasteJsonArea.value = "";
          await refresh();
        } catch (error) {
          setTestStatus("bad", error instanceof Error ? error.message : String(error));
        }
      });

      function inferPlan(fileName) {
        const stem = fileName.replace(/\.json(?:\.disabled)?$/, "");
        const parts = stem.split("-");
        return parts.length > 1 ? parts[parts.length - 1] : "free";
      }

      els.triggerOauthBtn.addEventListener("click", async () => {
        try {
          setTestStatus("neutral", "Triggering browser OAuth login…");
          const result = await postJson("/api/accounts/login-oauth", {});
          if (result.url) {
            window.open(result.url, "_blank");
          }
          setTestStatus("good", "OAuth login triggered! Please authenticate in the newly opened browser tab.");
        } catch (error) {
          setTestStatus("bad", error instanceof Error ? error.message : String(error));
        }
      });

        document.getElementById("redeem-reset-btn").addEventListener("click", () => {
          setTestStatus("warn", "Reset-credit redemption is outside this retained snapshot story.");
        });

      // Theme toggling logic
      const themeToggle = document.getElementById("theme-toggle");
      function getTheme() {
        return document.documentElement.getAttribute("data-theme") || "dark";
      }
      function setTheme(theme) {
        document.documentElement.setAttribute("data-theme", theme);
        localStorage.setItem("theme", theme);
        updateThemeIcon(theme);
      }
      function updateThemeIcon(theme) {
        if (theme === "dark") {
          themeToggle.innerHTML = \`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>\`;
        } else {
          themeToggle.innerHTML = \`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>\`;
        }
      }
      themeToggle.addEventListener("click", () => {
        const nextTheme = getTheme() === "dark" ? "light" : "dark";
        setTheme(nextTheme);
      });
      updateThemeIcon(getTheme());

      refresh();
      state.refreshTimer = window.setInterval(refresh, 60000);
    </script>
  </body>
</html>`;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardOptions,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === "api" && !isSameOriginRequest(req)) {
    jsonResponse(res, 403, { error: "same-origin dashboard request required" });
    return true;
  }
  if (requiresOperatorToken(method, url.pathname) && !hasValidOperatorToken(req, options)) {
    jsonResponse(res, 403, { error: "valid dashboard operator token required" });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/state") {
    jsonResponse(res, 200, await readDashboardState(options));
    return true;
  }

  if (method === "GET" && url.pathname === "/api/codex/rate-limits") {
    const codexBin = resolveCodexBin(options);
    try {
      const result = await queryCodexAppServer(codexBin, "account/rateLimits/read", {});
      const rawResult = result as any;
      const availableCount =
        typeof rawResult?.rateLimitResetCredits?.availableCount === "number" ||
        typeof rawResult?.rateLimitResetCredits?.availableCount === "bigint"
          ? Number(rawResult.rateLimitResetCredits.availableCount)
          : 0;
      jsonResponse(res, 200, { ok: true, availableCount });
    } catch (err: any) {
      if (err.message && err.message.includes("authentication required")) {
        jsonResponse(res, 200, { ok: false, error: err.message, authRequired: true, availableCount: 0 });
      } else {
        jsonResponse(res, 500, { error: err.message || String(err) });
      }
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/codex/consume-reset") {
    jsonResponse(res, 403, {
      ok: false,
      error: "Reset-credit redemption is outside the retained quota snapshot story",
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/routing") {
    const body = await readJsonBody(req);
    const strategy = typeof body.strategy === "string" ? body.strategy.trim() : "";
    const sessionAffinity =
      typeof body.sessionAffinity === "boolean" ? body.sessionAffinity : false;
    if (!strategy) {
      jsonResponse(res, 400, { error: "routing.strategy is required" });
      return true;
    }
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const updated = await setRoutingConfig(configPath, { strategy, sessionAffinity });
    jsonResponse(res, 200, { ok: true, config: publicConfig(updated) });
    return true;
  }

  if (method === "POST" && segments[0] === "api" && segments[1] === "test-request") {
    const body = await readJsonBody(req);
    const resolved = await resolveDashboardPaths(options);
    const result = await sendTestRequest(resolved, {
      model: typeof body.model === "string" ? body.model : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      maxOutputTokens: typeof body.maxOutputTokens === "number" ? body.maxOutputTokens : undefined,
    });
    jsonResponse(res, 200, result);
    return true;
  }

  if (method === "POST" && segments[0] === "api" && segments[1] === "accounts" && segments[2] === "login-oauth") {
    const body = (await readJsonBody(req).catch(() => ({}))) as any;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const resolved = await resolveDashboardPaths(options);

    try {
      await cleanupStuckOauthLogins();
      const url = await startOauthLogin(resolved.configPath, email, resolveCliProxyBin(options));
      jsonResponse(res, 200, { ok: true, url, message: "OAuth login URL generated" });
    } catch (error) {
      jsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (method === "POST" && segments[0] === "api" && segments[1] === "accounts" && segments.length === 2) {
    const body = await readJsonBody(req);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const plan = typeof body.plan === "string" ? body.plan.trim() : "";
    if (!email) {
      jsonResponse(res, 400, { error: "email is required" });
      return true;
    }
    if (!plan) {
      jsonResponse(res, 400, { error: "plan is required" });
      return true;
    }
    if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(email)) {
      jsonResponse(res, 400, { error: "invalid email format" });
      return true;
    }
    if (!/^[a-zA-Z0-9-_]+$/.test(plan)) {
      jsonResponse(res, 400, { error: "invalid plan format" });
      return true;
    }

    const resolved = await resolveDashboardPaths(options);
    const disabled = typeof body.disabled === "boolean" ? body.disabled : false;
    const priority =
      typeof body.priority === "number" && Number.isFinite(body.priority)
        ? Math.trunc(body.priority)
        : DEFAULT_PRIORITY;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
    const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
    const idToken = typeof body.id_token === "string" ? body.id_token.trim() : "";
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token.trim() : "";
    const expired = typeof body.expired === "string" ? body.expired.trim() : "";
    const lastRefresh = typeof body.last_refresh === "string" ? body.last_refresh.trim() : new Date().toISOString();

    const baseName = `codex-${email}-${plan}.json`;
    const targetFileName = disabled ? `${baseName}.disabled` : baseName;
    const targetPath = resolveAccountPath(resolved.authDir, targetFileName);

    let fileExists = false;
    try {
      await access(resolveAccountPath(resolved.authDir, baseName));
      fileExists = true;
    } catch {}
    try {
      await access(resolveAccountPath(resolved.authDir, `${baseName}.disabled`));
      fileExists = true;
    } catch {}

    if (fileExists) {
      jsonResponse(res, 400, { error: `Account file for ${email} with plan ${plan} already exists` });
      return true;
    }

    const payload: Record<string, unknown> = {
      email,
      priority,
      disabled,
      note,
      account_id: accountId,
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshToken,
      expired,
      last_refresh: lastRefresh,
      type: "codex",
    };

    if (!accessToken) delete payload.access_token;
    if (!idToken) delete payload.id_token;
    if (!refreshToken) delete payload.refresh_token;

    await atomicWriteText(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
    const account = normalizeAccount(targetPath, payload);
    jsonResponse(res, 201, { ok: true, account: publicAccount(account) });
    return true;
  }

  if (segments[0] === "api" && segments[1] === "accounts" && segments[2]) {
    const fileName = decodeURIComponent(segments[2]);
    const resolved = await resolveDashboardPaths(options);
    if ((method === "PATCH" || method === "POST") && segments.length === 3) {
      const body = await readJsonBody(req);
      const priority =
        body.priority === null
          ? null
          : typeof body.priority === "number" && Number.isFinite(body.priority)
            ? Math.trunc(body.priority)
            : undefined;
      const note =
        body.note === null ? null : typeof body.note === "string" ? body.note : undefined;
      const disabled =
        body.disabled === null
          ? null
          : typeof body.disabled === "boolean"
            ? body.disabled
            : undefined;
      const account = await setAccountPatch(resolved.authDir, resolved.backupRoot, fileName, {
        priority,
        note,
        disabled,
      });
      jsonResponse(res, 200, { ok: true, account: publicAccount(account) });
      return true;
    }
    if (method === "POST" && segments[3] === "primary") {
      const body = await readJsonBody(req);
      const backupPriority =
        typeof body.backupPriority === "number" && Number.isFinite(body.backupPriority)
          ? Math.trunc(body.backupPriority)
          : DEFAULT_BACKUP_PRIORITY;
      await promotePrimary(resolved.authDir, resolved.backupRoot, fileName, backupPriority);
      jsonResponse(res, 200, { ok: true });
      return true;
    }
    if (method === "POST" && segments[3] === "backup") {
      const account = await setAccountPatch(resolved.authDir, resolved.backupRoot, fileName, {
        priority: DEFAULT_BACKUP_PRIORITY,
        note: "backup",
      });
      jsonResponse(res, 200, { ok: true, account: publicAccount(account) });
      return true;
    }
    if (method === "POST" && segments[3] === "clear-priority") {
      const account = await setAccountPatch(resolved.authDir, resolved.backupRoot, fileName, {
        priority: null,
      });
      jsonResponse(res, 200, { ok: true, account: publicAccount(account) });
      return true;
    }
    if (method === "DELETE" && segments.length === 3) {
      const filePath = resolveAccountPath(resolved.authDir, fileName);
      let exists = false;
      try {
        await access(filePath);
        exists = true;
      } catch {}
      if (!exists) {
        jsonResponse(res, 404, { error: `Account not found: ${fileName}` });
        return true;
      }
      try {
        await mkdir(resolved.backupRoot, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const backupName = `${fileName}.deleted-${ts}`;
        await copyFile(filePath, path.join(resolved.backupRoot, backupName));
      } catch {}
      await unlink(filePath);
      jsonResponse(res, 200, { ok: true, deleted: fileName });
      return true;
    }
    if (method === "POST" && segments[3] === "verify") {
      const filePath = resolveAccountPath(resolved.authDir, fileName);
      let raw: Record<string, unknown> | null = null;
      try {
        raw = await readJsonObject(filePath);
      } catch {}
      if (!raw) {
        jsonResponse(res, 404, { error: `Account not found: ${fileName}` });
        return true;
      }

      const accessToken = asString(raw.access_token, "");
      const refreshToken = asString(raw.refresh_token, "");

      let isValid = false;
      let verifyErrorMsg = "";

      if (accessToken) {
        try {
          const modelRes = await fetch("https://api.openai.com/v1/models", {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          });
          if (modelRes.status === 200) {
            isValid = true;
          } else {
            const errText = await modelRes.text().catch(() => "");
            verifyErrorMsg = `Token invalid (HTTP ${modelRes.status}): ${errText.slice(0, 100)}`;
          }
        } catch (err) {
          verifyErrorMsg = `Network error during token check: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        verifyErrorMsg = "No access token present";
      }

      if (!isValid && refreshToken) {
        try {
          const refreshRes = await fetch("https://auth.openai.com/oauth/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              grant_type: "refresh_token",
              client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
              refresh_token: refreshToken,
            }),
          });

          if (refreshRes.ok) {
            const tokenData = (await refreshRes.json()) as any;
            if (tokenData && tokenData.access_token) {
              isValid = true;
              const nextAccessToken = tokenData.access_token;
              const nextRefreshToken = tokenData.refresh_token || refreshToken;
              const nextIdToken = tokenData.id_token || raw.id_token || "";

              let nextExpired = "";
              const expFromJwt = parseJwtExp(nextAccessToken);
              if (expFromJwt) {
                nextExpired = expFromJwt;
              } else if (typeof tokenData.expires_in === "number") {
                nextExpired = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
              } else {
                nextExpired = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
              }

              const updated = await mutateAccountFile(resolved.authDir, resolved.backupRoot, fileName, (acc) => {
                acc.access_token = nextAccessToken;
                acc.refresh_token = nextRefreshToken;
                if (nextIdToken) {
                  acc.id_token = nextIdToken;
                }
                acc.expired = nextExpired;
                acc.last_refresh = new Date().toISOString();
                acc.validity_status = "valid";
                acc.validation_error = "";
              });

              jsonResponse(res, 200, { ok: true, valid: true, refreshed: true, account: publicAccount(updated) });
              return true;
            } else {
              verifyErrorMsg = "OAuth response was missing access_token";
            }
          } else {
            const errJson = (await refreshRes.json().catch(() => ({}))) as any;
            const errDescription = errJson?.error_description || errJson?.error || await refreshRes.text().catch(() => "");
            verifyErrorMsg = `Session has ended (${errDescription || refreshRes.statusText})`;
          }
        } catch (err) {
          verifyErrorMsg = `Network error during token refresh: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      const targetStatus = isValid ? "valid" : "invalid";
      const updated = await mutateAccountFile(resolved.authDir, resolved.backupRoot, fileName, (acc) => {
        acc.validity_status = targetStatus;
        acc.validation_error = isValid ? "" : verifyErrorMsg;
      });

      jsonResponse(res, 200, {
        ok: true,
        valid: isValid,
        refreshed: false,
        error: isValid ? undefined : verifyErrorMsg,
        account: publicAccount(updated)
      });
      return true;
    }
  }

  return false;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? parsed : {};
}

async function startServer(
  options: DashboardOptions & { host: string; port: number; open?: boolean },
): Promise<void> {
  const serverOptions = {
    ...options,
    operatorToken: options.operatorToken ?? randomBytes(32).toString("base64url"),
  };
  const server = createServer(async (req, res) => {
    try {
      if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
        if (!isSameOriginRequest(req)) {
          jsonResponse(res, 403, { error: "same-origin dashboard request required" });
          return;
        }
        res.writeHead(204, {
          "Access-Control-Allow-Headers": `Content-Type, ${DASHBOARD_OPERATOR_TOKEN_HEADER}`,
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end();
        return;
        }
        if (await handleApi(req, res, serverOptions)) {
          return;
        }
      if ((req.method ?? "GET").toUpperCase() === "GET" && (req.url ?? "/") === "/") {
        textResponse(res, 200, htmlPage(serverOptions.operatorToken), "text/html; charset=utf-8");
        return;
      }
      jsonResponse(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jsonResponse(res, 500, { error: message });
    }
  });

  const listen = async (port: number): Promise<number> =>
    await new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (typeof address === "object" && address && "port" in address) {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not determine dashboard port"));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, options.host);
    });

  let actualPort: number;
  try {
    actualPort = await listen(options.port);
  } catch (error) {
    if (options.port !== 0) {
      actualPort = await listen(0);
    } else {
      throw error;
    }
  }

  const url = `http://${options.host}:${actualPort}`;
  process.stdout.write(`Cliproxy dashboard: ${url}\n`);
  process.stdout.write(`Config: ${options.configPath ?? DEFAULT_CONFIG_PATH}\n`);
  process.stdout.write(`Auth dir: ${options.authDir ?? DEFAULT_AUTH_DIR}\n`);
  process.stdout.write(`Quota snapshot state: ${options.quotaSnapshotStatePath ?? defaultQuotaSnapshotStatePath(options.authDir ?? DEFAULT_AUTH_DIR)}\n`);
  process.stdout.write(`CLI proxy bin: ${resolveCliProxyBin(options)}\n`);

  if (options.open) {
    openExternalUrl(url);
  }

  const shutdown = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  const onSignal = () => {
    void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await new Promise(() => undefined);
}

function parseCliArgs(argv = process.argv.slice(2)): {
  host: string;
  port: number;
  open: boolean;
  configPath?: string;
  authDir?: string;
    backupRoot?: string;
    mainLogPath?: string;
    quotaSnapshotStatePath?: string;
    proxyUrl?: string;
    proxyPort?: number;
    inboundKey?: string | null;
  cliProxyBin?: string;
} {
  const parsed = {
    host: DEFAULT_HOST,
    port: DEFAULT_DASHBOARD_PORT,
    open: false,
    configPath: undefined as string | undefined,
    authDir: undefined as string | undefined,
    backupRoot: undefined as string | undefined,
    mainLogPath: undefined as string | undefined,
    quotaSnapshotStatePath: undefined as string | undefined,
    proxyUrl: undefined as string | undefined,
    proxyPort: undefined as number | undefined,
    inboundKey: undefined as string | null | undefined,
    cliProxyBin: undefined as string | undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: cliproxy-dashboard [--host 127.0.0.1] [--port 60948] [--cli-proxy-bin <path>] [--config <path>] [--auth-dir <path>] [--backup-root <path>] [--state-file <path>] [--open]\n",
      );
      process.exit(0);
    }
    if (arg === "--open") {
      parsed.open = true;
      continue;
    }
    if (arg === "--host") {
      parsed.host = argv[++index] ?? DEFAULT_HOST;
      continue;
    }
    if (arg === "--port") {
      parsed.port = parseOptionalInteger(argv[++index], DEFAULT_DASHBOARD_PORT);
      continue;
    }
    if (arg === "--config") {
      parsed.configPath = argv[++index];
      continue;
    }
    if (arg === "--cli-proxy-bin") {
      parsed.cliProxyBin = argv[++index];
      continue;
    }
    if (arg === "--auth-dir") {
      parsed.authDir = argv[++index];
      continue;
    }
    if (arg === "--backup-root") {
      parsed.backupRoot = argv[++index];
      continue;
    }
    if (arg === "--main-log") {
      parsed.mainLogPath = argv[++index];
      continue;
    }
    if (arg === "--state-file") {
      parsed.quotaSnapshotStatePath = argv[++index];
      continue;
    }
    if (arg === "--proxy-url") {
      parsed.proxyUrl = argv[++index];
      continue;
    }
    if (arg === "--proxy-port") {
      parsed.proxyPort = parseOptionalInteger(argv[++index], DEFAULT_PROXY_PORT);
      continue;
    }
    if (arg === "--inbound-key") {
      parsed.inboundKey = argv[++index] ?? null;
      continue;
    }
  }
  return parsed;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cli = parseCliArgs(argv);
  await startServer(cli);
}

export {
  readDashboardState,
  readLogSummary,
  readAccounts,
  readConfig,
  parseRequestLine,
  parseSelectorLine,
  setRoutingConfig,
  setAccountPatch,
  sortAccounts,
  sendTestRequest,
  promotePrimary,
  handleApi,
  parseCliArgs,
  resolveCliProxyBin,
  resolveCodexBin,
  defaultCliProxyBin,
  buildOpenUrlCommand,
  buildStuckOauthCleanupCommand,
  DEFAULT_BACKUP_PRIORITY,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_PRIORITY,
};

const isDirectExecution = (() => {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
})();

if (isDirectExecution) {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
