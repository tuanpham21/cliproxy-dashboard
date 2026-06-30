import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  readDashboardState,
  setAccountPatch,
  setRoutingConfig,
  sortAccounts,
  handleApi,
  buildOpenUrlCommand,
  buildStuckOauthCleanupCommand,
  defaultCliProxyBin,
  parseCliArgs,
  resolveCliProxyBin,
  DEFAULT_DASHBOARD_PORT,
} from "./cliproxy-dashboard.js";

const spawnCalls = vi.hoisted((): Array<{ command: string; args: string[]; options: any }> => []);
const TEST_OPERATOR_TOKEN = "test-operator-token";

function sameOriginHeaders(includeOperatorToken = false): Record<string, string> {
  return {
    host: "127.0.0.1:60948",
    origin: "http://127.0.0.1:60948",
    "sec-fetch-site": "same-origin",
    ...(includeOperatorToken ? { "x-cliproxy-dashboard-token": TEST_OPERATOR_TOKEN } : {}),
  };
}

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

async function makeTempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "cliproxy-dashboard-"));
}

function accountFixture(
  fileName: string,
  overrides: Partial<{
    priority: number;
    disabled: boolean;
    note: string;
    accountId: string;
  }> = {},
) {
  return {
    fileName,
    path: path.join("/tmp", fileName),
    email: fileName.replace(/^codex-/, "").replace(/\.json(?:\.disabled)?$/, ""),
    priority: overrides.priority ?? 100,
    explicitPriority: overrides.priority !== undefined,
    disabled: overrides.disabled ?? false,
    note: overrides.note ?? "",
    accountId: overrides.accountId ?? "",
    accountIdShort: (overrides.accountId ?? "").slice(0, 8),
    type: "codex",
    plan: "plus",
    expired: "",
    lastRefresh: "",
    raw: {},
  };
}

function responseLogFixture(
  authFileName: string,
  overrides: Partial<{
    label: string;
    timestamp: string;
  }> = {},
) {
  const label =
    overrides.label ?? authFileName.replace(/^codex-/, "").replace(/\.json(?:\.disabled)?$/, "");
  const timestamp = overrides.timestamp ?? "2026-05-17T11:51:15.447929+07:00";
  return [
    "=== REQUEST INFO ===",
    "Version: 6.9.36",
    "URL: /v1/responses",
    "Method: POST",
    `Timestamp: ${timestamp}`,
    "",
    "=== API REQUEST 1 ===",
    `Auth: provider=codex, auth_id=${authFileName}, label=${label}, type=oauth`,
    "",
    ].join("\n");
}

async function writeConfig(root: string, authDir: string) {
  const configPath = path.join(root, "config.yaml");
  await writeFile(
    configPath,
    [
      "port: 8317",
      `auth-dir: ${authDir}`,
      "api-keys:",
      "  - key",
      "",
    ].join("\n"),
  );
  return configPath;
}

async function writeAccountFile(
  authDir: string,
  fileName: string,
  overrides: Record<string, unknown> = {},
) {
  await mkdir(authDir, { recursive: true });
  await writeFile(
    path.join(authDir, fileName),
    `${JSON.stringify(
      {
        email: fileName.replace(/^codex-/, "").replace(/\.json(?:\.disabled)?$/, ""),
        type: "codex",
        account_id: "acct-fixture-123456789",
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

async function writeQuotaResponseLog(
  logsDir: string,
  fileName: string,
  authFileName: string,
  options: Partial<{
    timestamp: string;
    primaryUsedPercent: number;
    primaryResetAfterSeconds: number;
    weeklyUsedPercent: number;
    weeklyResetAfterSeconds: number;
  }> = {},
) {
  await mkdir(logsDir, { recursive: true });
  const lines = [
    responseLogFixture(authFileName, {
      timestamp: options.timestamp ?? new Date().toISOString(),
    }),
  ];
  if (options.primaryUsedPercent !== undefined) {
    lines.push(`X-Codex-Primary-Used-Percent: ${options.primaryUsedPercent}`);
  }
  if (options.primaryResetAfterSeconds !== undefined) {
    lines.push(`X-Codex-Primary-Reset-After-Seconds: ${options.primaryResetAfterSeconds}`);
  }
  if (options.weeklyUsedPercent !== undefined) {
    lines.push(`X-Codex-Secondary-Used-Percent: ${options.weeklyUsedPercent}`);
  }
  if (options.weeklyResetAfterSeconds !== undefined) {
    lines.push(`X-Codex-Secondary-Reset-After-Seconds: ${options.weeklyResetAfterSeconds}`);
  }
  await writeFile(path.join(logsDir, fileName), `${lines.join("\n")}\n`);
}

function stubModelList() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/v1/models")) {
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }),
  );
}

function makeMockRes() {
  let status = 0;
  let headers: Record<string, string> = {};
  let responseBody = "";
  const res = {
    writeHead: (code: number, hdrs: Record<string, string>) => {
      status = code;
      headers = hdrs;
    },
    end: (body: string) => {
      responseBody = body;
    },
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => status,
    getHeaders: () => headers,
    getBody: () => responseBody,
    getParsed: () => JSON.parse(responseBody),
  };
}

describe("cliproxy dashboard helpers", () => {
  afterEach(() => {
    spawnCalls.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses Windows dashboard and cli-proxy-api defaults", () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(60948);
    expect(parseCliArgs([]).port).toBe(60948);
    expect(parseCliArgs(["--cli-proxy-bin", "D:\\Tools\\cli-proxy-api.exe"]).cliProxyBin).toBe(
      "D:\\Tools\\cli-proxy-api.exe",
    );
    expect(defaultCliProxyBin("win32")).toBe("C:\\Tools\\cli-proxy-api\\cli-proxy-api.exe");
  });

  it("resolves cli-proxy-api from explicit option before environment fallback", () => {
    const oldValue = process.env.CLI_PROXY_API_BIN;
    try {
      process.env.CLI_PROXY_API_BIN = "C:\\Env\\cli-proxy-api.exe";
      expect(resolveCliProxyBin()).toBe("C:\\Env\\cli-proxy-api.exe");
      expect(resolveCliProxyBin({ cliProxyBin: "C:\\Explicit\\cli-proxy-api.exe" })).toBe(
        "C:\\Explicit\\cli-proxy-api.exe",
      );
    } finally {
      if (oldValue === undefined) {
        delete process.env.CLI_PROXY_API_BIN;
      } else {
        process.env.CLI_PROXY_API_BIN = oldValue;
      }
    }
  });

  it("builds Windows-safe browser and stuck OAuth cleanup commands", () => {
    const opener = buildOpenUrlCommand("http://127.0.0.1:60948", "win32");
    expect(opener.command).toBe("rundll32.exe");
    expect(opener.args).toEqual(["url.dll,FileProtocolHandler", "http://127.0.0.1:60948"]);

    const cleanup = buildStuckOauthCleanupCommand("win32");
    const cleanupScript = cleanup.args.join(" ");
    expect(cleanup.command).toBe("powershell.exe");
    expect(cleanupScript).toContain("cli-proxy-api");
    expect(cleanupScript).toContain("-codex-login");
    expect(cleanupScript).toContain("$PID");
    expect(cleanupScript).toContain("ProcessId -ne $self");
  });

  it("sorts accounts by higher priority first and disabled last", () => {
    const sorted = sortAccounts([
      accountFixture("codex-a.json", { priority: 10 }),
      accountFixture("codex-b.json", { priority: 100 }),
      accountFixture("codex-c.json", { priority: 200, disabled: true }),
    ]);

    expect(sorted.map((account) => account.fileName)).toEqual([
      "codex-b.json",
      "codex-a.json",
      "codex-c.json",
    ]);
  });

  it("backs up and patches account files atomically", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const backupRoot = path.join(root, "backups");
    await mkdir(authDir, { recursive: true });

    const fileName = "codex-demo@example.com-plus.json";
    const filePath = path.join(authDir, fileName);
    await writeFile(
      filePath,
      `${JSON.stringify(
        {
          email: "demo@example.com",
          priority: 10,
          disabled: false,
          note: "old",
          account_id: "abcdef12-3456-7890-abcd-ef1234567890",
          extra: { keep: true },
        },
        null,
        2,
      )}\n`,
    );

    const updated = await setAccountPatch(authDir, backupRoot, fileName, {
      priority: 50,
      disabled: true,
      note: "new",
    });

    const disk = JSON.parse(await readFile(`${filePath}.disabled`, "utf8")) as Record<string, unknown>;
    expect(updated.priority).toBe(50);
    expect(updated.disabled).toBe(true);
    expect(disk).toMatchObject({
      priority: 50,
      disabled: true,
      note: "new",
      extra: { keep: true },
    });

    const backupDirs = await readdir(backupRoot);
    expect(backupDirs).toHaveLength(1);
    const backupFiles = await readdir(path.join(backupRoot, backupDirs[0]));
    expect(backupFiles).toContain(fileName);
  });

  it("updates routing config without dropping unrelated keys", async () => {
    const root = await makeTempRoot();
    const configPath = path.join(root, "config.yaml");
    await writeFile(
      configPath,
      [
        "port: 8317",
        "auth-dir: C:/Users/LEGION/.cli-proxy-api",
        "api-keys:",
        "  - codex-proxy-key",
        "routing:",
        "  strategy: fill-first",
        "  session-affinity: false",
        "request-retry: 2",
        "",
      ].join("\n"),
    );

    const updated = await setRoutingConfig(configPath, {
      strategy: "failover",
      sessionAffinity: true,
    });
    const disk = YAML.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    const routing = disk.routing as Record<string, unknown>;

    expect(updated?.routingStrategy).toBe("failover");
    expect(routing).toMatchObject({
      strategy: "failover",
      "session-affinity": true,
    });
    expect(disk["api-keys"]).toEqual(["codex-proxy-key"]);
    expect(disk["request-retry"]).toBe(2);
  });

  it("does not expose API key values in public dashboard state", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const configPath = path.join(root, "config.yaml");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      configPath,
      [
        "port: 8317",
        `auth-dir: ${authDir}`,
        "api-keys:",
        "  - secret-one",
        "  - secret-two",
        "",
      ].join("\n"),
    );

    const state = await readDashboardState({ configPath });
    expect((state.config as any).apiKeys).toBeUndefined();
    expect(state.config?.apiKeysConfigured).toBe(true);
    expect(state.config?.apiKeyCount).toBe(2);
    expect((state.paths as any).inboundKey).toBeUndefined();
    expect(state.paths.inboundKeyConfigured).toBe(true);
  });

  it("uses the default quota snapshot state path and trusted override with owner-only modes", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    await mkdir(authDir, { recursive: true });
    const configPath = await writeConfig(root, authDir);
    stubModelList();

    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    const expectedDefaultPath = path.join(authDir, "cliproxy-dashboard", "quota-snapshots.json");
    expect(state.paths.quotaSnapshotStatePath).toBe(expectedDefaultPath);
    expect((await stat(expectedDefaultPath)).isFile()).toBe(true);

    const overridePath = path.join(authDir, "cliproxy-dashboard", "override-quota-snapshots.json");
    const overrideState = await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "key",
      quotaSnapshotStatePath: overridePath,
    });
    expect(overrideState.paths.quotaSnapshotStatePath).toBe(overridePath);
    expect((await stat(overridePath)).isFile()).toBe(true);

    if (process.platform !== "win32") {
      expect((await stat(path.dirname(overridePath))).mode & 0o777).toBe(0o700);
      expect((await stat(overridePath)).mode & 0o777).toBe(0o600);
    }

    const beforeReplace = await stat(overridePath);
    const fileName = "codex-atomic@example.com-plus.json";
    await writeAccountFile(authDir, fileName, {
      id_token: "fixture-id-token",
    });
    await writeQuotaResponseLog(path.join(authDir, "logs"), "v1-responses-atomic.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 17,
      primaryResetAfterSeconds: 3600,
    });
    await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "key",
      quotaSnapshotStatePath: overridePath,
    });
    const afterReplace = await stat(overridePath);
    if (process.platform !== "win32") {
      expect(afterReplace.ino).not.toBe(beforeReplace.ino);
    }
    const stateDirEntries = await readdir(path.dirname(overridePath));
    expect(stateDirEntries.some((entry) => entry.startsWith(`.${path.basename(overridePath)}.`))).toBe(false);
  });

  it("retains quota snapshots across state reads, dashboard restart simulation, log aging, and no current logs", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-retained@example.com-plus.json";
    await writeAccountFile(authDir, fileName);
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "retained.json");
    stubModelList();

    const logPath = path.join(logsDir, "v1-responses-retained.log");
    await writeQuotaResponseLog(logsDir, path.basename(logPath), fileName, {
      timestamp: new Date(Date.now() - 1000).toISOString(),
      primaryUsedPercent: 35,
      primaryResetAfterSeconds: 3600,
      weeklyUsedPercent: 12,
      weeklyResetAfterSeconds: 86400,
    });

    const first = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(first.accounts[0].quota.primary5h).toMatchObject({ usedPercent: 35, status: "current" });
    expect(first.accounts[0].quota.weekly).toMatchObject({ usedPercent: 12, status: "current" });

    const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(logPath, oldDate, oldDate);
    const aged = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(aged.accounts[0].quota.primary5h).toMatchObject({ usedPercent: 35, status: "current" });
    expect(aged.accounts[0].quota.weekly).toMatchObject({ usedPercent: 12, status: "current" });

    await rm(logsDir, { recursive: true, force: true });
    await mkdir(logsDir, { recursive: true });
    const restarted = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(restarted.accounts[0].quota.primary5h).toMatchObject({ usedPercent: 35, status: "current" });
    expect(restarted.accounts[0].quota.weekly).toMatchObject({ usedPercent: 12, status: "current" });
  });

  it("merges newer response-header evidence per quota window without older overwrites", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-window@example.com-plus.json";
    await writeAccountFile(authDir, fileName);
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "window-merge.json");
    stubModelList();

    const now = Date.now();
    await writeQuotaResponseLog(logsDir, "v1-responses-base.log", fileName, {
      timestamp: new Date(now - 10_000).toISOString(),
      primaryUsedPercent: 30,
      primaryResetAfterSeconds: 3600,
      weeklyUsedPercent: 10,
      weeklyResetAfterSeconds: 86400,
    });
    const first = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(first.accounts[0].quota.primary5h.usedPercent).toBe(30);
    expect(first.accounts[0].quota.weekly.usedPercent).toBe(10);

    await writeQuotaResponseLog(logsDir, "v1-responses-older.log", fileName, {
      timestamp: new Date(now - 20_000).toISOString(),
      primaryUsedPercent: 90,
      primaryResetAfterSeconds: 3600,
      weeklyUsedPercent: 90,
      weeklyResetAfterSeconds: 86400,
    });
    const olderIgnored = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(olderIgnored.accounts[0].quota.primary5h.usedPercent).toBe(30);
    expect(olderIgnored.accounts[0].quota.weekly.usedPercent).toBe(10);

    await writeQuotaResponseLog(logsDir, "v1-responses-new-primary-only.log", fileName, {
      timestamp: new Date(now).toISOString(),
      primaryUsedPercent: 55,
      primaryResetAfterSeconds: 3600,
    });
    const partial = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(partial.accounts[0].quota.primary5h.usedPercent).toBe(55);
    expect(partial.accounts[0].quota.weekly.usedPercent).toBe(10);

    await writeQuotaResponseLog(logsDir, "v1-responses-new-weekly-only.log", fileName, {
      timestamp: new Date(now + 10_000).toISOString(),
      weeklyUsedPercent: 22,
      weeklyResetAfterSeconds: 86400,
    });
    const inversePartial = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(inversePartial.accounts[0].quota.primary5h.usedPercent).toBe(55);
    expect(inversePartial.accounts[0].quota.weekly.usedPercent).toBe(22);
  });

  it("does not let equal-timestamp response logs overwrite retained evidence", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-equal@example.com-plus.json";
    await writeAccountFile(authDir, fileName);
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "equal.json");
    stubModelList();

    const timestamp = new Date().toISOString();
    await writeQuotaResponseLog(logsDir, "v1-responses-a.log", fileName, {
      timestamp,
      primaryUsedPercent: 44,
      primaryResetAfterSeconds: 3600,
    });
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });

    await writeQuotaResponseLog(logsDir, "v1-responses-z.log", fileName, {
      timestamp,
      primaryUsedPercent: 91,
      primaryResetAfterSeconds: 3600,
    });
    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(state.accounts[0].quota.primary5h.usedPercent).toBe(44);
  });

  it("keeps retained snapshots stable across disable renames and hides orphaned snapshots", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const backupRoot = path.join(root, "backups");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-toggle@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { disabled: false });
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "toggle.json");
    stubModelList();

    await writeQuotaResponseLog(logsDir, "v1-responses-toggle.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 41,
      primaryResetAfterSeconds: 3600,
    });
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    await rm(logsDir, { recursive: true, force: true });
    await mkdir(logsDir, { recursive: true });

    await setAccountPatch(authDir, backupRoot, fileName, { disabled: true });
    const disabled = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(disabled.accounts[0].fileName).toBe(`${fileName}.disabled`);
    expect(disabled.accounts[0].quota.primary5h.usedPercent).toBe(41);
    const keyAfterDisable = JSON.parse(await readFile(statePath, "utf8")).snapshots[0].proxyAccountKey;
    expect(keyAfterDisable).toMatch(/^pak_v1_/);

    await setAccountPatch(authDir, backupRoot, `${fileName}.disabled`, { disabled: false });
    const enabled = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(enabled.accounts[0].fileName).toBe(fileName);
    expect(enabled.accounts[0].quota.primary5h.usedPercent).toBe(41);
    const keyAfterEnable = JSON.parse(await readFile(statePath, "utf8")).snapshots[0].proxyAccountKey;
    expect(keyAfterEnable).toBe(keyAfterDisable);

    await rm(path.join(authDir, fileName));
    const deleted = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(deleted.accounts).toHaveLength(0);
  });

  it("preserves passed-reset percentages and exposes refresh-needed", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-expired@example.com-plus.json";
    await writeAccountFile(authDir, fileName);
    const configPath = await writeConfig(root, authDir);
    stubModelList();

    await writeQuotaResponseLog(logsDir, "v1-responses-expired.log", fileName, {
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      primaryUsedPercent: 64,
      primaryResetAfterSeconds: 60,
    });

    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(state.accounts[0].quota.primary5h.usedPercent).toBe(64);
    expect(state.accounts[0].quota.primary5h.status).toBe("refresh-needed");
  });

  it("recomputes public status and treats missing or invalid reset times as refresh-needed", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-invalid-reset@example.com-plus.json";
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "invalid-reset.json");
    await writeAccountFile(authDir, fileName);
    stubModelList();

    await writeQuotaResponseLog(logsDir, "v1-responses-invalid-reset.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 71,
      primaryResetAfterSeconds: 3600,
    });
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });

    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    persisted.snapshots[0].primary5h.resetAt = "not-a-date";
    persisted.snapshots[0].primary5h.status = "current";
    await writeFile(statePath, `${JSON.stringify(persisted, null, 2)}\n`);
    await rm(logsDir, { recursive: true, force: true });
    await mkdir(logsDir, { recursive: true });

    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(state.accounts[0].quota.primary5h.usedPercent).toBe(71);
    expect(state.accounts[0].quota.primary5h.status).toBe("refresh-needed");
    expect(state.accounts[0].quota.primary5h.resetAt).toBeUndefined();
  });

  it("recovers from corrupt state files and persists only the allowlisted quota snapshot schema", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-schema@example.com-plus.json";
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "schema.json");
    await writeAccountFile(authDir, fileName);
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, "{not-json");
    stubModelList();

    await writeQuotaResponseLog(logsDir, "v1-responses-schema.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 21,
      primaryResetAfterSeconds: 3600,
      weeklyUsedPercent: 8,
      weeklyResetAfterSeconds: 86400,
    });
    const logPath = path.join(logsDir, "v1-responses-schema.log");
    await writeFile(
      logPath,
      `${await readFile(logPath, "utf8")}\nREQUEST BODY: raw-request-body-secret\nRESPONSE BODY: raw-response-body-secret\n`,
    );

    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(state.accounts[0].quota.primary5h.usedPercent).toBe(21);
    expect(state.errors.join("\n")).toContain("Quota snapshot state file could not be read");

    const text = await readFile(statePath, "utf8");
    const persisted = JSON.parse(text);
    expect(Object.keys(persisted).sort()).toEqual(["keyDerivation", "schemaVersion", "snapshots"]);
    expect(Object.keys(persisted.keyDerivation).sort()).toEqual(["algorithm", "keyPrefix", "secret"]);
    expect(Object.keys(persisted.snapshots[0]).sort()).toEqual(["primary5h", "proxyAccountKey", "weekly"]);
    expect(Object.keys(persisted.snapshots[0].primary5h).sort()).toEqual(["observedAt", "resetAt", "source", "usedPercent"]);
    const keys = new Set<string>();
    const collectKeys = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        value.forEach(collectKeys);
        return;
      }
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        keys.add(key);
        collectKeys(nested);
      }
    };
    collectKeys(persisted);
    expect(text).not.toContain("fixture-access-token");
    expect(text).not.toContain("fixture-refresh-token");
    expect(text).not.toContain("fixture-id-token");
    expect(text).not.toContain("raw-request-body-secret");
    expect(text).not.toContain("raw-response-body-secret");
    expect(text).not.toContain(fileName);
    expect(text).not.toContain(fileName.replace(/\.disabled$/, ""));
    expect(text).not.toContain(createHash("sha256").update(fileName.replace(/\.disabled$/, "")).digest("hex"));
    expect(text).not.toContain("schema@example.com");
    expect(text).not.toContain("acct-fixture");
    expect(text).not.toContain("label=");
    expect(keys).not.toContain("raw");
    expect(keys).not.toContain("path");
  });

  it("rewrites legacy persisted state files to remove disallowed fields", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-legacy@example.com-plus.json";
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "legacy.json");
    await writeAccountFile(authDir, fileName);
    stubModelList();

    await writeQuotaResponseLog(logsDir, "v1-responses-legacy.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 33,
      primaryResetAfterSeconds: 3600,
    });
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });

    const legacy = JSON.parse(await readFile(statePath, "utf8"));
    legacy.raw = { request: "raw-request-body-secret" };
    legacy.snapshots[0].fileName = fileName;
    legacy.snapshots[0].email = "legacy@example.com";
    legacy.snapshots[0].primary5h.resetAt = "not-a-date";
    legacy.snapshots[0].primary5h.status = "current";
    legacy.snapshots[0].primary5h.responseBody = "raw-response-body-secret";
    await writeFile(statePath, `${JSON.stringify(legacy, null, 2)}\n`);
    await rm(logsDir, { recursive: true, force: true });
    await mkdir(logsDir, { recursive: true });

    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(state.accounts[0].quota.primary5h.usedPercent).toBe(33);
    const cleanedText = await readFile(statePath, "utf8");
    const cleaned = JSON.parse(cleanedText);
    expect(Object.keys(cleaned).sort()).toEqual(["keyDerivation", "schemaVersion", "snapshots"]);
    expect(Object.keys(cleaned.snapshots[0]).sort()).toEqual(["primary5h", "proxyAccountKey"]);
    expect(Object.keys(cleaned.snapshots[0].primary5h).sort()).toEqual(["observedAt", "source", "usedPercent"]);
    expect(cleanedText).not.toContain(fileName);
    expect(cleanedText).not.toContain("legacy@example.com");
    expect(cleanedText).not.toContain("not-a-date");
    expect(cleanedText).not.toContain("raw-request-body-secret");
    expect(cleanedText).not.toContain("raw-response-body-secret");
  });

  it("does not lose newer retained evidence during overlapping state read and update", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-concurrent@example.com-plus.json";
    await writeAccountFile(authDir, fileName);
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "concurrent.json");
    stubModelList();

    await writeQuotaResponseLog(logsDir, "v1-responses-concurrent-old.log", fileName, {
      timestamp: new Date(Date.now() - 10_000).toISOString(),
      primaryUsedPercent: 15,
      primaryResetAfterSeconds: 3600,
    });

    let releaseFirstWrite!: () => void;
    let firstWriteIsPaused!: () => void;
    const releaseFirstWritePromise = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const firstWritePausedPromise = new Promise<void>((resolve) => {
      firstWriteIsPaused = resolve;
    });
    let hookCalls = 0;
    const firstRead = readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "key",
      quotaSnapshotStatePath: statePath,
      beforeQuotaSnapshotStateWrite: async () => {
        hookCalls += 1;
        if (hookCalls === 1) {
          firstWriteIsPaused();
          await releaseFirstWritePromise;
        }
      },
    });
    await firstWritePausedPromise;

    await writeQuotaResponseLog(logsDir, "v1-responses-concurrent-new.log", fileName, {
      timestamp: new Date().toISOString(),
      weeklyUsedPercent: 66,
      weeklyResetAfterSeconds: 86400,
    });

    const secondRead = readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    releaseFirstWrite();
    await Promise.all([firstRead, secondRead]);

    const finalState = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(finalState.accounts[0].quota.primary5h.usedPercent).toBe(15);
    expect(finalState.accounts[0].quota.weekly.usedPercent).toBe(66);
  });

  it("ignores API-supplied state paths and rejects cross-origin API requests", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    await mkdir(authDir, { recursive: true });
    const configPath = await writeConfig(root, authDir);
    const statePath = path.join(authDir, "cliproxy-dashboard", "api-owned.json");
    const maliciousPath = path.join(authDir, "cliproxy-dashboard", "malicious.json");
    stubModelList();

    const req = {
      method: "GET",
      url: `/api/state?quotaSnapshotStatePath=${encodeURIComponent(maliciousPath)}`,
      headers: sameOriginHeaders(),
    } as unknown as IncomingMessage;
    const res = makeMockRes();
    await handleApi(req, res.res, { configPath, proxyUrl: "http://proxy.local", inboundKey: "key", quotaSnapshotStatePath: statePath });
    expect(res.getStatus()).toBe(200);
    expect(res.getParsed().paths.quotaSnapshotStatePath).toBe(statePath);
    await expect(stat(maliciousPath)).rejects.toMatchObject({ code: "ENOENT" });

    const crossOriginReq = {
      method: "GET",
      url: "/api/state",
      headers: {
        host: "127.0.0.1:60948",
        origin: "http://evil.example",
      },
    } as unknown as IncomingMessage;
    const crossOriginRes = makeMockRes();
    await handleApi(crossOriginReq, crossOriginRes.res, { configPath });
    expect(crossOriginRes.getStatus()).toBe(403);

    const noOriginReq = {
      method: "GET",
      url: "/api/state",
      headers: { host: "127.0.0.1:60948" },
    } as unknown as IncomingMessage;
    const noOriginRes = makeMockRes();
    await handleApi(noOriginReq, noOriginRes.res, { configPath });
    expect(noOriginRes.getStatus()).toBe(403);

    const missingTokenReq = {
      method: "GET",
      url: "/api/codex/rate-limits",
      headers: sameOriginHeaders(false),
    } as unknown as IncomingMessage;
    const missingTokenRes = makeMockRes();
    await handleApi(missingTokenReq, missingTokenRes.res, { configPath, operatorToken: TEST_OPERATOR_TOKEN });
    expect(missingTokenRes.getStatus()).toBe(403);
  });

  it("rejects unsafe quota snapshot state paths", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    await mkdir(authDir, { recursive: true });
    const configPath = await writeConfig(root, authDir);
    stubModelList();

    const traversal = await readDashboardState({
      configPath,
      quotaSnapshotStatePath: path.join(authDir, "cliproxy-dashboard", "..", "outside.json"),
    });
    expect(traversal.errors.join("\n")).toContain("Quota snapshot state store unavailable");

    const credentialPath = path.join(authDir, "codex-unsafe@example.com-plus.json");
    await writeFile(credentialPath, "{}\n");
    const credential = await readDashboardState({ configPath, quotaSnapshotStatePath: credentialPath });
    expect(credential.errors.join("\n")).toContain("Quota snapshot state store unavailable");

    const configAsState = await readDashboardState({ configPath, quotaSnapshotStatePath: configPath });
    expect(configAsState.errors.join("\n")).toContain("Quota snapshot state store unavailable");

    const directoryPath = path.join(authDir, "cliproxy-dashboard", "directory.json");
    await mkdir(directoryPath, { recursive: true });
    const directory = await readDashboardState({ configPath, quotaSnapshotStatePath: directoryPath });
    expect(directory.errors.join("\n")).toContain("regular file");

    if (process.platform !== "win32") {
      const targetPath = path.join(authDir, "cliproxy-dashboard", "target.json");
      const linkPath = path.join(authDir, "cliproxy-dashboard", "link.json");
      await writeFile(targetPath, "{}\n");
      await symlink(targetPath, linkPath);
      const link = await readDashboardState({ configPath, quotaSnapshotStatePath: linkPath });
      expect(link.errors.join("\n")).toContain("symlink");

      await chmod(path.join(authDir, "cliproxy-dashboard"), 0o700);
      expect((await lstat(path.join(authDir, "cliproxy-dashboard"))).isDirectory()).toBe(true);
    }
  });

  it("tracks the latest Codex selection from the service log", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const configPath = path.join(root, "config.yaml");
    await mkdir(logsDir, { recursive: true });

    const stevenFileName = "codex-stevencakrawala@noriet.biz.id-plus.json";
    const tuanFileName = "codex-tuanpham.work21@gmail.com-plus.json";
    await writeFile(
      path.join(authDir, stevenFileName),
      `${JSON.stringify(
        {
          email: "stevencakrawala@noriet.biz.id",
          priority: 100,
          disabled: false,
          account_id: "abcdef12-3456-7890-abcd-ef1234567890",
          type: "codex",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(authDir, tuanFileName),
      `${JSON.stringify(
        {
          email: "tuanpham.work21@gmail.com",
          priority: 10,
          disabled: false,
          account_id: "12345678-90ab-cdef-1234-567890abcdef",
          type: "codex",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      configPath,
      [
        "port: 8317",
        `auth-dir: ${authDir}`,
        "api-keys:",
        "  - codex-proxy-key",
        "routing:",
        "  strategy: fill-first",
        "  session-affinity: false",
        "",
      ].join("\n"),
    );
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gpt-5.4-mini", owned_by: "openai", created: 1773705600, object: "model" },
              {
                id: "claude-opus-4.6",
                owned_by: "anthropic",
                created: 1778993447,
                object: "model",
              },
              { id: "gpt-5.4", owned_by: "openai", created: 1772668800, object: "model" },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    await writeFile(
      path.join(logsDir, "main.log"),
      [
        "[2026-05-17 10:37:28] [1e39afb0] [info ] [selector.go:500] session-affinity: cache hit | session=msg:7c64a28cedf23af7 auth=claude:apikey:1234 provider=mixed model=claude-opus-4.6",
        `[2026-05-17 10:37:29] [1e39afb1] [info ] [selector.go:500] session-affinity: cache miss, new binding | session=msg:593c79004589d8ee auth=${tuanFileName} provider=mixed model=gpt-5.4-mini`,
        `[2026-05-17 10:37:30] [e4102fbf] [info ] [gin_logger.go:94] 200 |        3.958s |       127.0.0.1 | POST    "/v1/responses"`,
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(logsDir, "v1-responses-2026-05-17T115100-0f8b0632.log"),
      responseLogFixture(tuanFileName, {
        timestamp: "2026-05-17T11:51:00.758479+07:00",
      }),
    );
    await writeFile(
      path.join(logsDir, "v1-responses-2026-05-17T115120-0eaa9117.log"),
      responseLogFixture(stevenFileName, {
        timestamp: "2026-05-17T11:51:15.447929+07:00",
      }),
    );

    const state = await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "codex-proxy-key",
    });

    expect(state.paths.authDir).toBe(authDir);
    expect(state.logSummary.latestSelection?.auth).toBe(tuanFileName);
    expect(state.selectedAccount?.fileName).toBe(stevenFileName);
    expect(state.logSummary.latestCodexSelection?.auth).toBe(stevenFileName);
    expect(state.models.map((model) => model.id)).toEqual([
      "claude-opus-4.6",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(state.logSummary.latestRequest?.path).toBe("/v1/responses");
    expect(state.config ? "raw" in state.config : false).toBe(false);
    expect(state.selectedAccount ? "raw" in state.selectedAccount : false).toBe(false);
    expect(state.accounts.some((account) => "raw" in account)).toBe(false);
  });

  it("manually registers new codex accounts", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const backupRoot = path.join(root, "backups");
    await mkdir(authDir, { recursive: true });

    // Mock options
      const options = {
        configPath: path.join(root, "config.yaml"),
        authDir,
        backupRoot,
        operatorToken: TEST_OPERATOR_TOKEN,
      };

    // Helper to mock request
      const createMockReq = (payload: any) => ({
        method: "POST",
        url: "/api/accounts",
        headers: sameOriginHeaders(true),
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify(payload));
        }
    } as unknown as IncomingMessage);

    // Helper to mock response
    let status = 0;
    let headers: Record<string, string> = {};
    let responseBody = "";
    const createMockRes = () => ({
      writeHead: (code: number, hdrs: Record<string, string>) => {
        status = code;
        headers = hdrs;
      },
      end: (body: string) => {
        responseBody = body;
      }
    } as unknown as ServerResponse);

    // 1. Success case
    const payload = {
      email: "new-user@example.com",
      plan: "plus",
      priority: 250,
      note: "newly added",
      account_id: "1234-abcd",
      access_token: "mock-access",
      disabled: false,
    };

    const res1 = createMockRes();
    const handled1 = await handleApi(createMockReq(payload), res1, options);
    expect(handled1).toBe(true);
    expect(status).toBe(201);
    const parsed1 = JSON.parse(responseBody);
    expect(parsed1.ok).toBe(true);
    expect(parsed1.account.email).toBe("new-user@example.com");
    expect(parsed1.account.plan).toBe("plus");
    expect(parsed1.account.priority).toBe(250);

    // Verify written file exists
    const fileText = await readFile(path.join(authDir, "codex-new-user@example.com-plus.json"), "utf8");
    const parsedDisk = JSON.parse(fileText);
    expect(parsedDisk).toMatchObject({
      email: "new-user@example.com",
      priority: 250,
      note: "newly added",
      account_id: "1234-abcd",
      access_token: "mock-access",
      disabled: false,
      type: "codex",
    });

    // 2. Duplicate case
    const res2 = createMockRes();
    const handled2 = await handleApi(createMockReq(payload), res2, options);
    expect(handled2).toBe(true);
    expect(status).toBe(400);
    const parsed2 = JSON.parse(responseBody);
    expect(parsed2.error).toContain("already exists");

    // 3. Validation case: invalid email
    const badPayload1 = { ...payload, email: "not-an-email" };
    const res3 = createMockRes();
    const handled3 = await handleApi(createMockReq(badPayload1), res3, options);
    expect(handled3).toBe(true);
    expect(status).toBe(400);
    expect(JSON.parse(responseBody).error).toContain("invalid email");

    // 4. Validation case: invalid plan
    const badPayload2 = { ...payload, email: "another@example.com", plan: "bad/plan" };
    const res4 = createMockRes();
    const handled4 = await handleApi(createMockReq(badPayload2), res4, options);
    expect(handled4).toBe(true);
    expect(status).toBe(400);
    expect(JSON.parse(responseBody).error).toContain("invalid plan");
  });

  it("triggers OAuth login workflow", async () => {
    const root = await makeTempRoot();
      const options = {
        configPath: path.join(root, "config.yaml"),
        authDir: path.join(root, "auth"),
        backupRoot: path.join(root, "backups"),
        cliProxyBin: "C:\\Tools\\cli-proxy-api\\cli-proxy-api.exe",
        operatorToken: TEST_OPERATOR_TOKEN,
      };

      const req = {
        method: "POST",
        url: "/api/accounts/login-oauth",
        headers: sameOriginHeaders(true),
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({ email: "test@example.com" }));
        }
    } as unknown as IncomingMessage;

    let status = 0;
    let responseBody = "";
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (body: string) => {
        responseBody = body;
      }
    } as unknown as ServerResponse;

    const handled = await handleApi(req, res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    const parsed = JSON.parse(responseBody);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toContain("https://auth.openai.com/oauth/authorize");
    expect(parsed.url).toContain("login_hint=test%40example.com");
    expect(spawnCalls.some((call) => call.command === options.cliProxyBin)).toBe(true);
  });

  it("verifies and refreshes Codex account tokens via verify endpoint", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const backupRoot = path.join(root, "backups");
    await mkdir(authDir, { recursive: true });

      const options = {
        configPath: path.join(root, "config.yaml"),
        authDir,
        backupRoot,
        operatorToken: TEST_OPERATOR_TOKEN,
      };

    // Helper to mock request
      const createMockReq = () => ({
        method: "POST",
        url: "/api/accounts/codex-test%40example.com-plus.json/verify",
        headers: sameOriginHeaders(true),
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({}));
        }
    } as unknown as IncomingMessage);

    let status = 0;
    let responseBody = "";
    const createMockRes = () => ({
      writeHead: (code: number) => {
        status = code;
      },
      end: (body: string) => {
        responseBody = body;
      }
    } as unknown as ServerResponse);

    // Write a mock account file
    const accountFile = path.join(authDir, "codex-test@example.com-plus.json");
    await writeFile(
      accountFile,
      JSON.stringify({
        email: "test@example.com",
        access_token: "old-access-token",
        refresh_token: "old-refresh-token",
        expired: "",
        last_refresh: "",
        type: "codex",
      }, null, 2)
    );

    // 1. Success case: access token is valid (fetch to v1/models returns 200)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url === "https://api.openai.com/v1/models") {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response("", { status: 404 });
      })
    );

    let res = createMockRes();
    let handled = await handleApi(createMockReq(), res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    let body = JSON.parse(responseBody);
    expect(body.valid).toBe(true);
    expect(body.refreshed).toBe(false);

    // Verify written file has validity_status = "valid"
    let fileJson = JSON.parse(await readFile(accountFile, "utf8"));
    expect(fileJson.validity_status).toBe("valid");

    // 2. Refresh case: access token is invalid (401), but refresh token is valid (returns new tokens)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url === "https://api.openai.com/v1/models") {
          return new Response("", { status: 401 });
        }
        if (url === "https://auth.openai.com/oauth/token") {
          // Verify request body is correct
          const body = JSON.parse(init.body);
          expect(body.grant_type).toBe("refresh_token");
          expect(body.refresh_token).toBe("old-refresh-token");

          // Note: parts[1] is base64url encoded payload: {"exp": 1780000000} -> eyJleHAiOjE3ODAwMDAwMDB9
          return new Response(
            JSON.stringify({
              access_token: "header.eyJleHAiOjE3ODAwMDAwMDB9.sig",
              refresh_token: "new-refresh-token",
              expires_in: 86400,
            }),
            { status: 200 }
          );
        }
        return new Response("", { status: 404 });
      })
    );

    res = createMockRes();
    handled = await handleApi(createMockReq(), res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    body = JSON.parse(responseBody);
    expect(body.valid).toBe(true);
    expect(body.refreshed).toBe(true);

    fileJson = JSON.parse(await readFile(accountFile, "utf8"));
    expect(fileJson.access_token).toBe("header.eyJleHAiOjE3ODAwMDAwMDB9.sig");
    expect(fileJson.refresh_token).toBe("new-refresh-token");
    expect(fileJson.validity_status).toBe("valid");
    expect(fileJson.expired).toBe(new Date(1780000000 * 1000).toISOString());

    // 3. Failed case: both access token and refresh token are invalid (session ended)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url === "https://api.openai.com/v1/models") {
          return new Response("", { status: 401 });
        }
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Your session has ended.",
            }),
            { status: 400 }
          );
        }
        return new Response("", { status: 404 });
      })
    );

    res = createMockRes();
    handled = await handleApi(createMockReq(), res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    body = JSON.parse(responseBody);
    expect(body.valid).toBe(false);
    expect(body.refreshed).toBe(false);
    expect(body.error).toContain("Session has ended");

    fileJson = JSON.parse(await readFile(accountFile, "utf8"));
    expect(fileJson.validity_status).toBe("invalid");
    expect(fileJson.validation_error).toContain("Session has ended");
  });

  it("decodes the id_token JWT for ChatGPT subscription quota and plan details", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    await mkdir(authDir, { recursive: true });

    const fileName = "codex-test@example.com-plus.json";
    const filePath = path.join(authDir, fileName);

    // Mock ID token with standard chatgpt subscription details
    // header: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9
    // payload: {"https://api.openai.com/auth": {"chatgpt_plan_type": "plus", "chatgpt_subscription_active_until": "2026-10-16T16:59:35+00:00"}}
    const mockIdToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwbHVzIiwiY2hhdGdwdF9zdWJzY3JpcHRpb25fYWN0aXZlX3VudGlsIjoiMjAyNi0xMC0xNlQxNjo1OTozNSswMDowMCJ9fQ.sig";

    await writeFile(
      filePath,
      JSON.stringify({
        email: "test@example.com",
        id_token: mockIdToken,
        type: "codex",
      })
    );

    const configPath = path.join(root, "config.yaml");
    await writeFile(
      configPath,
      [
        "port: 8317",
        `auth-dir: ${authDir}`,
        "api-keys:",
        "  - key",
        "",
      ].join("\n")
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
        }
        return new Response("", { status: 404 });
      })
    );

    const state = await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "key",
    });

    const account = state.accounts.find((a) => a.email === "test@example.com");
    expect(account).toBeDefined();
    expect(account?.subscriptionPlan).toBe("plus");
    expect(account?.subscriptionActiveUntil).toBe("2026-10-16T16:59:35+00:00");
  });

  it("parses and extracts subscription quota headers from responses logs", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    await mkdir(logsDir, { recursive: true });

    const fileName = "codex-test@example.com-plus.json";
    const filePath = path.join(authDir, fileName);

    await writeFile(
      filePath,
      JSON.stringify({
        email: "test@example.com",
        type: "codex",
      })
    );

    // Write a mock responses log file with Codex headers
    await writeFile(
      path.join(logsDir, "v1-responses-2026-06-07T190000-abcd.log"),
      [
        "=== REQUEST INFO ===",
        "Timestamp: 2026-06-07T19:00:00.000Z",
        "=== API REQUEST 1 ===",
        `Auth: provider=codex, auth_id=${fileName}, label=test, type=oauth`,
        "X-Codex-Primary-Used-Percent: 35",
        "X-Codex-Primary-Reset-After-Seconds: 3600",
        "X-Codex-Secondary-Used-Percent: 12",
        "X-Codex-Secondary-Reset-After-Seconds: 86400",
      ].join("\n")
    );

    const configPath = path.join(root, "config.yaml");
    await writeFile(
      configPath,
      [
        "port: 8317",
        `auth-dir: ${authDir}`,
        "api-keys:",
        "  - key",
        "",
      ].join("\n")
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
        }
        return new Response("", { status: 404 });
      })
    );

    const state = await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "key",
    });

    const account = state.accounts.find((a) => a.email === "test@example.com");
    expect(account).toBeDefined();
    expect(account?.quota.primary5h.usedPercent).toBe(35);
    expect(account?.quota.weekly.usedPercent).toBe(12);
  });

  describe("Codex rate limit reset feature API", () => {
      const options = {
        codexBin: "codex-test-bin",
        operatorToken: TEST_OPERATOR_TOKEN,
      };

    afterEach(() => {
      delete (globalThis as any).__mockCodexRateLimitsCount;
      delete (globalThis as any).__mockCodexAuthRequired;
      spawnCalls.length = 0;
    });

    const createMockReq = (method: string, urlPath: string, payload?: any) => {
        const req: any = {
          method,
          url: urlPath,
          headers: sameOriginHeaders(true),
        };
      if (payload) {
        req[Symbol.asyncIterator] = async function* () {
          yield Buffer.from(JSON.stringify(payload));
        };
      }
      return req as IncomingMessage;
    };

    const makeRes = () => {
      let status = 0;
      let headers: Record<string, string> = {};
      let responseBody = "";
      const res = {
        writeHead: (code: number, hdrs: Record<string, string>) => {
          status = code;
          headers = hdrs;
        },
        end: (body: string) => {
          responseBody = body;
        }
      } as unknown as ServerResponse;
      return {
        res,
        getStatus: () => status,
        getHeaders: () => headers,
        getBody: () => responseBody,
        getParsed: () => JSON.parse(responseBody),
      };
    };

    it("returns available count when Codex rateLimitResetCredits are read successfully", async () => {
      (globalThis as any).__mockCodexRateLimitsCount = 5;
      (globalThis as any).__mockCodexAuthRequired = false;

      const req = createMockReq("GET", "/api/codex/rate-limits");
      const mockRes = makeRes();

      const handled = await handleApi(req, mockRes.res, options);
      expect(handled).toBe(true);
      expect(mockRes.getStatus()).toBe(200);
      expect(mockRes.getParsed()).toEqual({ ok: true, availableCount: 5 });

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].command).toBe("codex-test-bin");
      expect(spawnCalls[0].args).toEqual(["app-server", "--stdio"]);
    });

    it("returns authRequired true when Codex rate limits read fails with authentication required", async () => {
      (globalThis as any).__mockCodexRateLimitsCount = 0;
      (globalThis as any).__mockCodexAuthRequired = true;

      const req = createMockReq("GET", "/api/codex/rate-limits");
      const mockRes = makeRes();

      const handled = await handleApi(req, mockRes.res, options);
      expect(handled).toBe(true);
      expect(mockRes.getStatus()).toBe(200);
      expect(mockRes.getParsed().authRequired).toBe(true);
      expect(mockRes.getParsed().ok).toBe(false);
    });

    it("rejects rate limit reset credit redemption as out of scope", async () => {
      (globalThis as any).__mockCodexAuthRequired = false;

      const req = createMockReq("POST", "/api/codex/consume-reset", {
        idempotencyKey: "test-uuid-v4-key",
      });
      const mockRes = makeRes();

      const handled = await handleApi(req, mockRes.res, options);
      expect(handled).toBe(true);
      expect(mockRes.getStatus()).toBe(403);
      expect(mockRes.getParsed()).toEqual({
        ok: false,
        error: "Reset-credit redemption is outside the retained quota snapshot story",
      });

      expect(spawnCalls.length).toBe(0);
    });

    it("rejects reset redemption even when idempotencyKey is missing", async () => {
      const req = createMockReq("POST", "/api/codex/consume-reset", {});
      const mockRes = makeRes();

      const handled = await handleApi(req, mockRes.res, options);
      expect(handled).toBe(true);
      expect(mockRes.getStatus()).toBe(403);
      expect(mockRes.getParsed().error).toContain("outside the retained quota snapshot story");
    });
  });

});
