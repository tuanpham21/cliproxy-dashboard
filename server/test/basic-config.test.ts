import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { setAccountPatch, sortAccounts } from "../accounts.js";
import { parseCliArgs } from "../cli.js";
import { buildOpenUrlCommand, buildStuckOauthCleanupCommand, defaultCliProxyBin, resolveCliProxyBin } from "../commands.js";
import { setRoutingConfig } from "../config.js";
import { DEFAULT_DASHBOARD_PORT } from "../constants.js";
import { readDashboardState } from "../dashboard-state.js";
import { spawnCalls } from "./mock-child-process.js";
import {
  TEST_OPERATOR_TOKEN,
  accountFixture,
  makeMockRes,
  makeTempRoot,
  responseLogFixture,
  sameOriginHeaders,
  stubModelList,
  writeAccountFile,
  writeConfig,
  writeQuotaResponseLog,
} from "./helpers.js";


describe("cliproxy dashboard basic config helpers", () => {
  it("uses Windows dashboard and cli-proxy-api defaults", () => {
    expect(DEFAULT_DASHBOARD_PORT).toBe(60948);
    expect(parseCliArgs([]).port).toBe(60948);
    expect(parseCliArgs([]).allowPortFallback).toBe(true);
    expect(parseCliArgs(["--no-port-fallback"]).allowPortFallback).toBe(false);
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

});
