import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { WINDOWS_CLI_PROXY_BIN } from "./constants.js";
import type { DashboardOptions } from "./types.js";

export function defaultCliProxyBin(platform = process.platform): string {
  return platform === "win32" ? WINDOWS_CLI_PROXY_BIN : "cli-proxy-api";
}

export function resolveCliProxyBin(options: Pick<DashboardOptions, "cliProxyBin"> = {}): string {
  return options.cliProxyBin ?? process.env.CLI_PROXY_API_BIN ?? defaultCliProxyBin();
}

export type ResolveCodexBinDependencies = {
  env: { CODEX_BIN?: string };
  execPath: string;
  platform: NodeJS.Platform;
  exists: (candidate: string) => boolean;
};

export function resolveCodexBin(
  options: Pick<DashboardOptions, "codexBin"> = {},
  dependencies: ResolveCodexBinDependencies = {
    env: process.env,
    execPath: process.execPath,
    platform: process.platform,
    exists: existsSync,
  },
): string {
  if (options.codexBin) return options.codexBin;
  if (dependencies.env.CODEX_BIN) return dependencies.env.CODEX_BIN;
  const pathApi = dependencies.platform === "win32" ? path.win32 : path;
  const localBin = pathApi.join(
    pathApi.dirname(dependencies.execPath),
    dependencies.platform === "win32" ? "codex.exe" : "codex",
  );
  if (dependencies.exists(localBin)) {
    return localBin;
  }
  return "codex";
}

export function buildOpenUrlCommand(
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

export function buildStuckOauthCleanupCommand(
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

export async function cleanupStuckOauthLogins(): Promise<void> {
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

export function openExternalUrl(url: string): void {
  const opener = buildOpenUrlCommand(url);
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

export async function startOauthLogin(configPath: string, email?: string, cliProxyBin?: string): Promise<string> {
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
