import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { CodexProfileLoginRunner } from "../codex-profile-login-runner.js";

class FakeLoginChild extends EventEmitter {
  killed = false;

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("close", signal === "SIGKILL" ? 137 : 0, signal ?? null));
    return true;
  }
}

describe("Codex Login Profile login runner", () => {
  it("starts official browser login in one private context and cancellation logs out that same context", async () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown>; child: FakeLoginChild }> = [];
    const spawnProcess = vi.fn((command: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeLoginChild();
      calls.push({ command, args, options, child });
      queueMicrotask(() => child.emit("spawn"));
      if (args[0] === "logout") queueMicrotask(() => child.emit("close", 0, null));
      return child as never;
    });
    const runner = new CodexProfileLoginRunner({ spawnProcess, env: { PATH: "/trusted/bin", CODEX_HOME: "/wrong" } });
    const runtimeContext = {
      codexStateRoot: "/private/codex-profiles/profile_A",
      codexSqliteRoot: "/private/codex-profiles/profile_A",
    };

    await runner.start({ profileId: "profile_A", codexBin: "/trusted/bin/codex", runtimeContext });

    expect(calls[0]).toMatchObject({
      command: "/trusted/bin/codex",
      args: [
        "login",
        "-c",
        'model_provider="openai"',
        "-c",
        'sqlite_home="/private/codex-profiles/profile_A"',
      ],
      options: {
        shell: false,
        windowsHide: false,
        stdio: "ignore",
        env: {
          PATH: "/trusted/bin",
          CODEX_HOME: "/private/codex-profiles/profile_A",
          CODEX_SQLITE_HOME: "/private/codex-profiles/profile_A",
        },
      },
    });
    expect(calls[0]?.args.join(" ")).not.toMatch(/--profile|with-api-key|with-access-token|device-auth/i);

    await runner.cancel({ profileId: "profile_A", codexBin: "/trusted/bin/codex", runtimeContext });

    expect(calls[0]?.child.killed).toBe(true);
    expect(calls[1]).toMatchObject({
      command: "/trusted/bin/codex",
      args: [
        "logout",
        "-c",
        'model_provider="openai"',
        "-c",
        'sqlite_home="/private/codex-profiles/profile_A"',
      ],
    });
  });

  it("waits for login completion and escalates a stubborn cancellation before keyring cleanup", async () => {
    const signals: Array<NodeJS.Signals | undefined> = [];
    let spawnCount = 0;
    const spawnProcess = vi.fn(() => {
      const child = new FakeLoginChild();
      spawnCount += 1;
      if (spawnCount === 1) {
        child.kill = (signal?: NodeJS.Signals) => {
          signals.push(signal);
          child.killed = true;
          if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
          return true;
        };
      } else {
        queueMicrotask(() => child.emit("close", 0, null));
      }
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    });
    const runner = new CodexProfileLoginRunner({ spawnProcess, cancelTimeoutMs: 5 });
    const input = {
      profileId: "profile_A",
      codexBin: "codex",
      runtimeContext: {
        codexStateRoot: "/private/codex-profiles/profile_A",
        codexSqliteRoot: "/private/codex-profiles/profile_A",
      },
    };
    await runner.start(input);

    await runner.cancel(input);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("waits for a successful official login and reports only a fixed failure for a failed child", async () => {
    const children: FakeLoginChild[] = [];
    const runner = new CodexProfileLoginRunner({
      spawnProcess: vi.fn(() => {
        const child = new FakeLoginChild();
        children.push(child);
        queueMicrotask(() => child.emit("spawn"));
        return child as never;
      }),
    });
    const input = {
      profileId: "profile_A",
      codexBin: "codex",
      runtimeContext: {
        codexStateRoot: "/private/codex-profiles/profile_A",
        codexSqliteRoot: "/private/codex-profiles/profile_A",
      },
    };

    await runner.start(input);
    queueMicrotask(() => children[0]?.emit("close", 0, null));
    await expect(runner.wait(input.profileId)).resolves.toBeUndefined();

    await runner.start(input);
    queueMicrotask(() => children[1]?.emit("close", 9, null));
    const error = await runner.wait(input.profileId).catch((caught) => caught);
    expect(error).toMatchObject({ message: "Codex Login Profile login failed." });
    expect(String(error)).not.toContain("private/codex-profiles");
  });

  it("bounds waiting for an unfinished browser login while leaving it cancellable", async () => {
    let spawnCount = 0;
    const runner = new CodexProfileLoginRunner({
      loginWaitTimeoutMs: 5,
      spawnProcess: vi.fn(() => {
        const child = new FakeLoginChild();
        spawnCount += 1;
        queueMicrotask(() => child.emit("spawn"));
        if (spawnCount > 1) queueMicrotask(() => child.emit("close", 0, null));
        return child as never;
      }),
    });
    const input = {
      profileId: "profile_A",
      codexBin: "codex",
      runtimeContext: {
        codexStateRoot: "/private/codex-profiles/profile_A",
        codexSqliteRoot: "/private/codex-profiles/profile_A",
      },
    };
    await runner.start(input);

    await expect(runner.wait(input.profileId)).rejects.toThrow("Codex Login Profile login failed.");
    await expect(runner.cancel(input)).resolves.toBeUndefined();
  }, 250);

  it("bounds a stubborn official logout and kills it instead of waiting forever", async () => {
    const logoutSignals: Array<NodeJS.Signals | undefined> = [];
    let spawnCount = 0;
    const runner = new CodexProfileLoginRunner({
      logoutTimeoutMs: 5,
      cancelTimeoutMs: 5,
      spawnProcess: vi.fn(() => {
        const child = new FakeLoginChild();
        spawnCount += 1;
        if (spawnCount === 2) {
          child.kill = (signal?: NodeJS.Signals) => {
            logoutSignals.push(signal);
            child.killed = true;
            if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
            return true;
          };
        }
        queueMicrotask(() => child.emit("spawn"));
        return child as never;
      }),
    });
    const input = {
      profileId: "profile_A",
      codexBin: "codex",
      runtimeContext: {
        codexStateRoot: "/private/codex-profiles/profile_A",
        codexSqliteRoot: "/private/codex-profiles/profile_A",
      },
    };
    await runner.start(input);

    await expect(runner.cancel(input)).rejects.toThrow("Codex Login Profile login failed.");
    expect(logoutSignals).toContain("SIGKILL");
  }, 250);

  it("closes every active profile login during server shutdown", async () => {
    const loginChildren: FakeLoginChild[] = [];
    const spawnProcess = vi.fn((_command: string, args: string[]) => {
      const child = new FakeLoginChild();
      if (args[0] === "login") loginChildren.push(child);
      else queueMicrotask(() => child.emit("close", 0, null));
      queueMicrotask(() => child.emit("spawn"));
      return child as never;
    });
    const runner = new CodexProfileLoginRunner({ spawnProcess });
    const runtimeContext = {
      codexStateRoot: "/private/codex-profiles/profile_A",
      codexSqliteRoot: "/private/codex-profiles/profile_A",
    };
    await runner.start({ profileId: "profile_A", codexBin: "codex", runtimeContext });
    await runner.start({ profileId: "profile_B", codexBin: "codex", runtimeContext });

    await runner.close();

    expect(loginChildren).toHaveLength(2);
    expect(loginChildren.every((child) => child.killed)).toBe(true);
    expect(spawnProcess).toHaveBeenCalledTimes(4);
  });
});
