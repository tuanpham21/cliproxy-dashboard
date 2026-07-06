import os from "node:os";
import path from "node:path";

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_DASHBOARD_PORT = 60948;
export const DEFAULT_PROXY_PORT = 8317;
export const DEFAULT_PRIORITY = 100;
export const DEFAULT_BACKUP_PRIORITY = 10;
export const DEFAULT_TEST_MODEL = "gpt-5.4-mini";
export const DEFAULT_TEST_PROMPT = "cliproxy dashboard test request";
export const DEFAULT_TEST_OUTPUT_TOKENS = 1;
export const DEFAULT_LOG_BYTES = 512_000;

export const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config/cli-proxy-api/config.yaml");
export const DEFAULT_AUTH_DIR = path.join(os.homedir(), ".cli-proxy-api");
export const DEFAULT_BACKUP_ROOT = path.join(os.homedir(), ".cli-proxy-api-backups", "cliproxy-dashboard");
export const WINDOWS_CLI_PROXY_BIN = "C:\\Tools\\cli-proxy-api\\cli-proxy-api.exe";
export const DASHBOARD_STATE_DIR_NAME = "cliproxy-dashboard";
export const QUOTA_SNAPSHOT_STATE_FILE_NAME = "quota-snapshots.json";
export const QUOTA_SNAPSHOT_SCHEMA_VERSION = 1;
export const DASHBOARD_OPERATOR_TOKEN_HEADER = "x-cliproxy-dashboard-token";
