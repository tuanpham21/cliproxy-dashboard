import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";

export type ProcessOwner = { pid: number; processStartIdentity: string };
export type ProcessOwnerStatus = "alive" | "dead" | "pid-reused" | "unverifiable";
export type ProcessOwnerCommandRunner = (
  binary: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ stdout: string }>;

const WINDOWS_PROCESS_IDENTITY_SCRIPT = `& {
  param([string]$RequestedPid)
  $ErrorActionPreference = 'Stop'
  try {
    $candidate = Get-Process -Id ([int]$RequestedPid) -ErrorAction SilentlyContinue
    if ($null -eq $candidate) {
      [Console]::Out.Write('{"status":"absent"}')
      return
    }
    try {
      $identity = $candidate.StartTime.ToUniversalTime().Ticks.ToString()
      [Console]::Out.Write(([pscustomobject]@{ status = 'found'; identity = $identity } | ConvertTo-Json -Compress))
    } catch {
      [Console]::Out.Write('{"status":"unknown"}')
    }
  } catch {
    [Console]::Out.Write('{"status":"unknown"}')
  }
}`;
const WINDOWS_LOCAL_APP_DATA_SCRIPT = `[Console]::Out.Write(
  [Environment]::GetFolderPath(
    [Environment+SpecialFolder]::LocalApplicationData,
    [Environment+SpecialFolderOption]::DoNotVerify
  )
)`;

function defaultRunCommand(binary: string, args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 8 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });
}

async function windowsIdentity(pid: number, runCommand: ProcessOwnerCommandRunner): Promise<
  { status: "found"; identity: string } | { status: "absent" } | { status: "unknown" }
> {
  try {
    const result = await runCommand("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      WINDOWS_PROCESS_IDENTITY_SCRIPT,
      String(pid),
    ], 5_000);
    const parsed = JSON.parse(result.stdout.trim()) as { status?: unknown; identity?: unknown };
    if (parsed.status === "absent") return { status: "absent" };
    if (parsed.status === "found" && typeof parsed.identity === "string" && parsed.identity) {
      return { status: "found", identity: parsed.identity };
    }
  } catch {
    // Fail closed below.
  }
  return { status: "unknown" };
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function linuxIdentity(bootId: string, statText: string): string | null {
  const closeParen = statText.lastIndexOf(")");
  if (closeParen < 0) return null;
  const fields = statText.slice(closeParen + 2).trim().split(/\s+/);
  const startTicks = fields[19];
  return startTicks ? `${bootId.trim()}:${startTicks}` : null;
}

async function darwinIdentity(pid: number): Promise<{ status: "found"; identity: string } | { status: "absent" } | { status: "unknown" }> {
  return await new Promise((resolve) => {
    execFile("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 }, (error, stdout) => {
      const identity = String(stdout).trim();
      if (!error && identity) resolve({ status: "found", identity });
      else if (!identity && (!error || (error as { code?: string | number }).code === 1)) resolve({ status: "absent" });
      else resolve({ status: "unknown" });
    });
  });
}

function windowsLocalApplicationData(): string {
  return String(execFileSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    WINDOWS_LOCAL_APP_DATA_SCRIPT,
  ], { timeout: 5_000, windowsHide: true, shell: false, maxBuffer: 8 * 1024 })).trim();
}

export function resolveFixedRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
  resolveWindowsLocalApplicationData: () => string = windowsLocalApplicationData,
): string {
  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "cliproxy-dashboard", "codex-reset-redemption");
  }
  if (platform === "linux") {
    const xdg = env.XDG_STATE_HOME;
    const parent = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".local", "state");
    return path.join(parent, "cliproxy-dashboard", "codex-reset-redemption");
  }
  if (platform === "win32") {
    let localApplicationData: string;
    try {
      localApplicationData = resolveWindowsLocalApplicationData();
    } catch {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
    if (!path.win32.isAbsolute(localApplicationData) || localApplicationData.startsWith("\\\\")) {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
    return path.win32.join(localApplicationData, "cliproxy-dashboard", "codex-reset-redemption");
  }
  throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
}

export async function currentProcessOwner(
  platform: NodeJS.Platform,
  runCommand: ProcessOwnerCommandRunner = defaultRunCommand,
): Promise<ProcessOwner> {
  if (platform === "linux") {
    const [bootId, statText] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${process.pid}/stat`, "utf8"),
    ]);
    const identity = linuxIdentity(bootId, statText);
    if (!identity) throw new Error("process identity unavailable");
    return { pid: process.pid, processStartIdentity: identity };
  }
  if (platform === "darwin") {
    const result = await darwinIdentity(process.pid);
    if (result.status !== "found") throw new Error("process identity unavailable");
    return { pid: process.pid, processStartIdentity: result.identity };
  }
  if (platform === "win32") {
    const result = await windowsIdentity(process.pid, runCommand);
    if (result.status !== "found") throw new Error("process identity unavailable");
    return { pid: process.pid, processStartIdentity: result.identity };
  }
  throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
}

export async function inspectProcessOwner(
  platform: NodeJS.Platform,
  owner: ProcessOwner,
  runCommand: ProcessOwnerCommandRunner = defaultRunCommand,
): Promise<ProcessOwnerStatus> {
  if (platform === "linux") {
    try {
      const [bootId, statText] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${owner.pid}/stat`, "utf8"),
      ]);
      const identity = linuxIdentity(bootId, statText);
      return !identity ? "unverifiable" : identity === owner.processStartIdentity ? "alive" : "pid-reused";
    } catch (error) {
      return isEnoent(error) ? "dead" : "unverifiable";
    }
  }
  if (platform === "darwin") {
    const result = await darwinIdentity(owner.pid);
    if (result.status === "absent") return "dead";
    if (result.status === "unknown") return "unverifiable";
    return result.identity === owner.processStartIdentity ? "alive" : "pid-reused";
  }
  if (platform === "win32") {
    const result = await windowsIdentity(owner.pid, runCommand);
    if (result.status === "absent") return "dead";
    if (result.status === "unknown") return "unverifiable";
    return result.identity === owner.processStartIdentity ? "alive" : "pid-reused";
  }
  return "unverifiable";
}
