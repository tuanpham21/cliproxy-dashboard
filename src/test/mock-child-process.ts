import { afterEach, vi } from "vitest";

const spawnCalls = vi.hoisted((): Array<{ command: string; args: string[]; options: any }> => []);

export { spawnCalls };

vi.mock("node:child_process", () => {
  return {
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
        const processCallbacks: Record<string, any[]> = {};

        const triggerStdout = (data: string) => {
          for (const cb of stdoutCallbacks) {
            cb(Buffer.from(data + "\n"));
          }
        };

        const mockChild = {
          unref: () => {},
          kill: () => {
            const exitCallbacks = processCallbacks["exit"] || [];
            for (const cb of exitCallbacks) {
              cb(0);
            }
          },
          stdin: {
            write: (data: string) => {
              const req = JSON.parse(data.trim());
              if (req.method === "initialize") {
                const res = {
                  jsonrpc: "2.0",
                  id: req.id,
                  result: {
                    capabilities: { experimentalApi: true },
                    serverInfo: { name: "codex-mock", version: "1.0.0" }
                  }
                };
                setTimeout(() => triggerStdout(JSON.stringify(res)), 5);
              } else if (req.method === "initialized") {
                // Do nothing
              } else if (req.method === "account/rateLimits/read") {
                const availableCount = (globalThis as any).__mockCodexRateLimitsCount ?? 3;
                const authRequired = (globalThis as any).__mockCodexAuthRequired ?? false;
                if (authRequired) {
                  const res = {
                    jsonrpc: "2.0",
                    id: req.id,
                    error: { code: -32001, message: "authentication required" }
                  };
                  setTimeout(() => triggerStdout(JSON.stringify(res)), 5);
                } else {
                  const res = {
                    jsonrpc: "2.0",
                    id: req.id,
                    result: {
                      rateLimitResetCredits: { availableCount }
                    }
                  };
                  setTimeout(() => triggerStdout(JSON.stringify(res)), 5);
                }
              } else if (req.method === "account/rateLimitResetCredit/consume") {
                const authRequired = (globalThis as any).__mockCodexAuthRequired ?? false;
                if (authRequired) {
                  const res = {
                    jsonrpc: "2.0",
                    id: req.id,
                    error: { code: -32001, message: "authentication required" }
                  };
                  setTimeout(() => triggerStdout(JSON.stringify(res)), 5);
                } else {
                  const res = {
                    jsonrpc: "2.0",
                    id: req.id,
                    result: {
                      outcome: "success"
                    }
                  };
                  setTimeout(() => triggerStdout(JSON.stringify(res)), 5);
                }
              }
            }
          },
          stdout: {
            setEncoding: () => {},
            on: (event: string, callback: any) => {
              if (event === "data") stdoutCallbacks.push(callback);
            },
            off: () => {},
            removeAllListeners: () => { stdoutCallbacks.length = 0; },
          },
          stderr: {
            setEncoding: () => {},
            on: (event: string, callback: any) => {
              if (event === "data") stderrCallbacks.push(callback);
            },
            off: () => {},
            removeAllListeners: () => { stderrCallbacks.length = 0; },
          },
          on: (event: string, callback: any) => {
            if (!processCallbacks[event]) processCallbacks[event] = [];
            processCallbacks[event].push(callback);
          },
          off: () => {},
          removeAllListeners: () => {
            for (const key of Object.keys(processCallbacks)) {
              processCallbacks[key].length = 0;
            }
          },
        } as any;

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
