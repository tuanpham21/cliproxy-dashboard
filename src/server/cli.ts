import process from "node:process";

import { DEFAULT_DASHBOARD_PORT, DEFAULT_HOST, DEFAULT_PROXY_PORT } from "./constants.js";
import { startServer } from "./server.js";
import { parseOptionalInteger } from "./util.js";

export function parseCliArgs(argv = process.argv.slice(2)): {
  host: string;
  port: number;
  open: boolean;
  allowPortFallback: boolean;
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
    allowPortFallback: true,
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
        "Usage: cliproxy-dashboard [--host 127.0.0.1] [--port 60948] [--no-port-fallback] [--cli-proxy-bin <path>] [--config <path>] [--auth-dir <path>] [--backup-root <path>] [--state-file <path>] [--open]\n",
      );
      process.exit(0);
    }
    if (arg === "--open") {
      parsed.open = true;
      continue;
    }
    if (arg === "--no-port-fallback") {
      parsed.allowPortFallback = false;
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
