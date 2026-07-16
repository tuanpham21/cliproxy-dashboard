import { describe, expect, it, vi } from "vitest";

import {
  currentProcessOwner,
  inspectProcessOwner,
  resolveFixedRoot,
  type ProcessOwnerCommandRunner,
} from "../codex-redemption-private-owner.js";

describe("Windows reset-redemption process ownership", () => {
  it("uses the OS LocalApplicationData known folder instead of process environment", () => {
    expect(resolveFixedRoot(
      "win32",
      { LOCALAPPDATA: "C:\\spoofed\\state" },
      () => "ignored",
      () => "C:\\Users\\Operator Name\\AppData\\Local",
    ))
      .toBe("C:\\Users\\Operator Name\\AppData\\Local\\cliproxy-dashboard\\codex-reset-redemption");
    expect(() => resolveFixedRoot(
      "win32",
      {},
      () => "ignored",
      () => "\\\\server\\shared-state",
    )).toThrow("Private reset redemption state is unavailable on this host.");
    expect(() => resolveFixedRoot(
      "win32",
      {},
      () => "ignored",
      () => { throw new Error("PowerShell blocked"); },
    )).toThrow("Private reset redemption state is unavailable on this host.");
  });

  it("records current process creation identity through a fixed PowerShell command", async () => {
    const calls: Array<{ binary: string; args: string[]; timeoutMs: number }> = [];
    const runCommand: ProcessOwnerCommandRunner = vi.fn(async (binary, args, timeoutMs) => {
      calls.push({ binary, args, timeoutMs });
      return { stdout: '{"status":"found","identity":"638882640001234567"}' };
    });

    await expect(currentProcessOwner("win32", runCommand)).resolves.toEqual({
      pid: process.pid,
      processStartIdentity: "638882640001234567",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].binary).toBe("powershell.exe");
    expect(calls[0].args.slice(0, 6)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    expect(calls[0].args.at(-1)).toBe(String(process.pid));
    expect(calls[0].args[6]).not.toContain(String(process.pid));
  });

  it("classifies alive, dead, PID-reused, and unverifiable Windows owners", async () => {
    const owner = { pid: 4321, processStartIdentity: "100" };
    const runner = (stdout: string): ProcessOwnerCommandRunner => vi.fn(async () => ({ stdout }));

    await expect(inspectProcessOwner("win32", owner, runner('{"status":"found","identity":"100"}'))).resolves.toBe("alive");
    await expect(inspectProcessOwner("win32", owner, runner('{"status":"found","identity":"101"}'))).resolves.toBe("pid-reused");
    await expect(inspectProcessOwner("win32", owner, runner('{"status":"absent"}'))).resolves.toBe("dead");
    await expect(inspectProcessOwner("win32", owner, runner("malformed"))).resolves.toBe("unverifiable");
    await expect(inspectProcessOwner("win32", owner, vi.fn(async () => { throw new Error("denied"); }))).resolves.toBe("unverifiable");
  });

  it.runIf(process.platform === "win32")("validates the real current Windows process start identity", async () => {
    const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const runCommand: ProcessOwnerCommandRunner = (binary, args, timeoutMs) => new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 8 * 1024 }, (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout) });
      });
    });
    const owner = await currentProcessOwner("win32", runCommand);

    await expect(inspectProcessOwner("win32", owner, runCommand)).resolves.toBe("alive");
    await expect(inspectProcessOwner("win32", {
      ...owner,
      processStartIdentity: `${owner.processStartIdentity}-stale`,
    }, runCommand)).resolves.toBe("pid-reused");
  });
});
