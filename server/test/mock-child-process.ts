import { afterEach, vi } from "vitest";

const spawnCalls = vi.hoisted((): Array<{ command: string; args: string[]; options: any }> => []);

export { spawnCalls };

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: any) => {
      spawnCalls.push({ command, args, options });
      if (command === "pkill" || command === "powershell.exe") {
        return {
          on: (event: string, callback: any) => {
            if (event === "close") setTimeout(() => callback(0), 5);
          },
        } as any;
      }
      if (args && args.includes("app-server")) {
        const stdoutCallbacks: any[] = [];
        const stderrCallbacks: any[] = [];
        const stdinCallbacks: Record<string, any[]> = {};
        const processCallbacks: Record<string, any[]> = {};

        const triggerStdout = (data: string) => {
          for (const callback of stdoutCallbacks) {
            callback(Buffer.from(`${data}\n`));
          }
        };

        const mockChild = {
          killed: false,
          unref: () => {},
          kill: () => {
            mockChild.killed = true;
            for (const callback of processCallbacks.exit ?? []) callback(0);
            for (const callback of processCallbacks.close ?? []) callback(0);
            return true;
          },
          stdin: {
            destroyed: false,
            write: (data: string, callback?: (error?: Error | null) => void) => {
              const request = JSON.parse(data.trim());
              queueMicrotask(() => callback?.());
              if (request.method === "initialize") {
                setTimeout(
                  () =>
                    triggerStdout(
                      JSON.stringify({
                        jsonrpc: "2.0",
                        id: request.id,
                        result: { serverInfo: { name: "codex-mock", version: "1.0.0" } },
                      }),
                    ),
                  5,
                );
              } else if (request.method === "account/rateLimits/read") {
                const availableCount = (globalThis as any).__mockCodexRateLimitsCount ?? 3;
                const credits = (globalThis as any).__mockCodexRateLimitCredits ?? null;
                const authRequired = (globalThis as any).__mockCodexAuthRequired ?? false;
                const response = authRequired
                  ? {
                      jsonrpc: "2.0",
                      id: request.id,
                      error: { code: -32001, message: "authentication required" },
                    }
                  : {
                      jsonrpc: "2.0",
                      id: request.id,
                      result: {
                        rateLimits: {},
                        rateLimitResetCredits: { availableCount, credits },
                      },
                    };
                setTimeout(() => triggerStdout(JSON.stringify(response)), 5);
              } else if (request.method === "account/rateLimitResetCredit/consume") {
                throw new Error("unexpected provider mutation in read-only Codex mock");
              }
              return true;
            },
            end: () => {
              mockChild.stdin.destroyed = true;
            },
            on: (event: string, callback: any) => {
              if (!stdinCallbacks[event]) stdinCallbacks[event] = [];
              stdinCallbacks[event].push(callback);
            },
            off: () => {},
          },
          stdout: {
            setEncoding: () => {},
            on: (event: string, callback: any) => {
              if (event === "data") stdoutCallbacks.push(callback);
            },
            off: () => {},
            removeAllListeners: () => {
              stdoutCallbacks.length = 0;
            },
          },
          stderr: {
            setEncoding: () => {},
            on: (event: string, callback: any) => {
              if (event === "data") stderrCallbacks.push(callback);
            },
            off: () => {},
            removeAllListeners: () => {
              stderrCallbacks.length = 0;
            },
          },
          on: (event: string, callback: any) => {
            if (!processCallbacks[event]) processCallbacks[event] = [];
            processCallbacks[event].push(callback);
          },
          off: () => {},
          removeAllListeners: () => {
            for (const key of Object.keys(processCallbacks)) processCallbacks[key].length = 0;
          },
        } as any;

        queueMicrotask(() => {
          for (const callback of processCallbacks.spawn ?? []) callback();
        });
        return mockChild;
      }
      return {
        unref: () => {},
        kill: () => {},
        stdout: {
          setEncoding: () => {},
          on: (event: string, callback: any) => {
            if (event === "data") {
              setTimeout(() => {
                callback(Buffer.from("Visit the following URL to continue authentication:\nhttps://auth.openai.com/oauth/authorize?client_id=app_EMoamEEZ73f0CkXaXp7hrann\n"));
              }, 5);
            }
          },
          off: () => {},
        },
        on: () => {},
        off: () => {},
      } as any;
    },
  };
});

afterEach(() => {
  delete (globalThis as any).__mockCodexRateLimitsCount;
  delete (globalThis as any).__mockCodexAuthRequired;
  spawnCalls.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
