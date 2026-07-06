import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

import { DASHBOARD_STATE_DIR_NAME, DEFAULT_AUTH_DIR, DEFAULT_BACKUP_ROOT, DEFAULT_CONFIG_PATH, DEFAULT_HOST, DEFAULT_PROXY_PORT, QUOTA_SNAPSHOT_STATE_FILE_NAME } from "./constants.js";
import { chooseInboundKey, readConfig } from "./config.js";
import type { DashboardOptions, DashboardPaths, PublicDashboardPaths } from "./types.js";
import { isRecord, parseOptionalInteger } from "./util.js";

export function safeBasename(value: string): string {
  const base = path.basename(value);
  if (base !== value) {
    throw new Error(`Invalid file name: ${value}`);
  }
  return base;
}

export function resolveAccountPath(authDir: string, fileName: string): string {
  const resolved = path.resolve(authDir, safeBasename(fileName));
  const prefix = `${path.resolve(authDir)}${path.sep}`;
  if (resolved !== path.resolve(authDir) && !resolved.startsWith(prefix)) {
    throw new Error(`Account file escapes auth dir: ${fileName}`);
  }
  return resolved;
}

export function publicDashboardPaths(paths: DashboardPaths): PublicDashboardPaths {
  const { inboundKey: _inboundKey, ...publicPaths } = paths;
  return {
    ...publicPaths,
    inboundKeyConfigured: Boolean(paths.inboundKey),
  };
}

export function defaultQuotaSnapshotStatePath(authDir: string): string {
  return path.join(authDir, DASHBOARD_STATE_DIR_NAME, QUOTA_SNAPSHOT_STATE_FILE_NAME);
}

export function resolveQuotaSnapshotStatePath(authDir: string, overridePath?: string): string {
  return path.resolve(overridePath ?? defaultQuotaSnapshotStatePath(authDir));
}

export function isCodexCredentialFileName(fileName: string): boolean {
  return /^codex-.*\.json(?:\.disabled)?$/.test(fileName);
}

export function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

export async function ensureOwnerOnlyDirectory(dirPath: string): Promise<void> {
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

export async function validateQuotaSnapshotStatePath(
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

export async function resolveDashboardPaths(options: DashboardOptions = {}): Promise<DashboardPaths> {
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
