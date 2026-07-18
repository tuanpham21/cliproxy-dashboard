import { spawn, type ChildProcess } from "node:child_process";
import process from "node:process";

import type { CodexRuntimeContext } from "./codex-runtime-context.js";

type LoginChild = Pick<ChildProcess, "once" | "off" | "kill" | "killed">;

export type CodexProfileLoginSpawn = (
  command: string,
  args: string[],
  options: {
    shell: false;
    windowsHide: boolean;
    stdio: "ignore";
    env: NodeJS.ProcessEnv;
  },
) => LoginChild;

export type CodexProfileLoginInput = {
  profileId: string;
  codexBin: string;
  runtimeContext: CodexRuntimeContext;
};

type ActiveLogin = { child: LoginChild; completion: Promise<void>; input: CodexProfileLoginInput };

type CodexProfileLoginRunnerDependencies = {
  spawnProcess?: CodexProfileLoginSpawn;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cancelTimeoutMs?: number;
  loginWaitTimeoutMs?: number;
  logoutTimeoutMs?: number;
};

const PROVIDER_OVERRIDE = 'model_provider="openai"';

function defaultSpawnProcess(
  command: string,
  args: string[],
  options: Parameters<CodexProfileLoginSpawn>[2],
): LoginChild {
  return spawn(command, args, options);
}

export class CodexProfileLoginError extends Error {
  constructor() {
    super("Codex Login Profile login failed.");
    this.name = "CodexProfileLoginError";
  }
}

export class CodexProfileLoginRunner {
  private readonly spawnProcess: CodexProfileLoginSpawn;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly cancelTimeoutMs: number;
  private readonly loginWaitTimeoutMs: number;
  private readonly logoutTimeoutMs: number;
  private readonly active = new Map<string, ActiveLogin>();

  constructor(dependencies: CodexProfileLoginRunnerDependencies = {}) {
    this.spawnProcess = dependencies.spawnProcess ?? defaultSpawnProcess;
    this.env = dependencies.env ?? process.env;
    this.platform = dependencies.platform ?? process.platform;
    this.cancelTimeoutMs = dependencies.cancelTimeoutMs ?? 5_000;
    this.loginWaitTimeoutMs = dependencies.loginWaitTimeoutMs ?? 30_000;
    this.logoutTimeoutMs = dependencies.logoutTimeoutMs ?? 10_000;
  }

  async start(input: CodexProfileLoginInput): Promise<void> {
    if (this.active.has(input.profileId)) throw new CodexProfileLoginError();
    const child = this.spawn(input, "login");
    const completion = this.completionFor(child);
    completion.catch(() => {});
    this.active.set(input.profileId, { child, completion, input });
    try {
      await this.waitForSpawn(child);
    } catch {
      this.active.delete(input.profileId);
      if (!child.killed) child.kill("SIGTERM");
      throw new CodexProfileLoginError();
    }
  }

  async wait(profileId: string): Promise<void> {
    const active = this.active.get(profileId);
    if (!active) throw new CodexProfileLoginError();
    const result = await this.completionWithin(active.completion, this.loginWaitTimeoutMs);
    if (result === "timeout") throw new CodexProfileLoginError();
    if (this.active.get(profileId) === active) this.active.delete(profileId);
    if (result === "rejected") throw new CodexProfileLoginError();
  }

  async cancel(input: CodexProfileLoginInput): Promise<void> {
    const active = this.active.get(input.profileId);
    if (active) {
      if (!active.child.killed) active.child.kill("SIGTERM");
      await this.waitForCancellation(active.child, active.completion);
      if (this.active.get(input.profileId) === active) this.active.delete(input.profileId);
    }
    const logoutChild = this.spawn(input, "logout");
    const logoutCompletion = this.completionFor(logoutChild);
    try {
      await this.waitForSpawn(logoutChild);
      const result = await this.completionWithin(logoutCompletion, this.logoutTimeoutMs);
      if (result === "timeout") {
        if (!logoutChild.killed) logoutChild.kill("SIGTERM");
        await this.waitForCancellation(logoutChild, logoutCompletion);
        throw new CodexProfileLoginError();
      }
      if (result === "rejected") throw new CodexProfileLoginError();
    } catch {
      if (!logoutChild.killed) logoutChild.kill("SIGKILL");
      throw new CodexProfileLoginError();
    }
  }

  async close(): Promise<void> {
    const inputs = [...this.active.values()].map((active) => active.input);
    const results = await Promise.allSettled(inputs.map(async (input) => await this.cancel(input)));
    if (results.some((result) => result.status === "rejected")) throw new CodexProfileLoginError();
  }

  private spawn(input: CodexProfileLoginInput, command: "login" | "logout"): LoginChild {
    const sqliteOverride = `sqlite_home=${JSON.stringify(input.runtimeContext.codexSqliteRoot)}`;
    try {
      return this.spawnProcess(
        input.codexBin,
        [command, "-c", PROVIDER_OVERRIDE, "-c", sqliteOverride],
        {
          shell: false,
          windowsHide: this.platform === "win32",
          stdio: "ignore",
          env: {
            ...this.env,
            CODEX_HOME: input.runtimeContext.codexStateRoot,
            CODEX_SQLITE_HOME: input.runtimeContext.codexSqliteRoot,
          },
        },
      );
    } catch {
      throw new CodexProfileLoginError();
    }
  }

  private waitForSpawn(child: LoginChild): Promise<void> {
    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new CodexProfileLoginError());
      };
      const cleanup = () => {
        child.off("spawn", onSpawn);
        child.off("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  private completionFor(child: LoginChild): Promise<void> {
    return new Promise((resolve, reject) => {
      const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        if (code === 0 && signal === null) resolve();
        else reject(new CodexProfileLoginError());
      };
      const onError = () => {
        cleanup();
        reject(new CodexProfileLoginError());
      };
      const cleanup = () => {
        child.off("close", onClose);
        child.off("error", onError);
      };
      child.once("close", onClose);
      child.once("error", onError);
    });
  }

  private async waitForCancellation(child: LoginChild, completion: Promise<void>): Promise<void> {
    if (await this.settlesWithin(completion, this.cancelTimeoutMs)) return;
    child.kill("SIGKILL");
    if (!(await this.settlesWithin(completion, this.cancelTimeoutMs))) throw new CodexProfileLoginError();
  }

  private settlesWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      completion.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(true);
        },
      );
    });
  }

  private completionWithin(
    completion: Promise<void>,
    timeoutMs: number,
  ): Promise<"fulfilled" | "rejected" | "timeout"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), timeoutMs);
      completion.then(
        () => {
          clearTimeout(timer);
          resolve("fulfilled");
        },
        () => {
          clearTimeout(timer);
          resolve("rejected");
        },
      );
    });
  }
}
