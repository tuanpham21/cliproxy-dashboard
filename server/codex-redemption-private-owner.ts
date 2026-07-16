import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";

export type ProcessOwner = { pid: number; processStartIdentity: string };
export type ProcessOwnerStatus = "alive" | "dead" | "pid-reused" | "unverifiable";

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

export function resolveFixedRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homedir: () => string): string {
  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "cliproxy-dashboard", "codex-reset-redemption");
  }
  if (platform === "linux") {
    const xdg = env.XDG_STATE_HOME;
    const parent = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".local", "state");
    return path.join(parent, "cliproxy-dashboard", "codex-reset-redemption");
  }
  if (platform === "win32" && env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)) {
    return path.win32.join(env.LOCALAPPDATA, "cliproxy-dashboard", "codex-reset-redemption");
  }
  throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
}

export async function currentProcessOwner(platform: NodeJS.Platform): Promise<ProcessOwner> {
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
  throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
}

export async function inspectProcessOwner(platform: NodeJS.Platform, owner: ProcessOwner): Promise<ProcessOwnerStatus> {
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
  return "unverifiable";
}
