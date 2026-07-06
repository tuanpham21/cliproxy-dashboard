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

export function resolveCodexBin(options: Pick<DashboardOptions, "codexBin"> = {}): string {
  if (options.codexBin) return options.codexBin;
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  const localBin = path.join(path.dirname(process.execPath), process.platform === "win32" ? "codex.exe" : "codex");
  if (existsSync(localBin)) {
    return localBin;
  }
  return "codex";
}

export async function queryCodexAppServer(
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
