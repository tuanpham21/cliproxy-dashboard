import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readDashboardState } from "../dashboard-state.js";
import { readCompletedCodexRoutes } from "../logs.js";
import { readAccounts } from "../accounts.js";
import { readMergedQuotaSnapshots } from "../quota-log-updates.js";
import {
  makeTempRoot,
  responseLogFixture,
  stubModelList,
  writeAccountFile,
  writeConfig,
  writeQuotaResponseLog,
} from "./helpers.js";

async function persistDashboardState(configPath: string, authDir: string) {
  const paths = {
    configPath,
    authDir,
    logsDir: path.join(authDir, "logs"),
    quotaSnapshotStatePath: path.join(authDir, "cliproxy-dashboard", "quota-snapshots.json"),
    proxyUrl: "http://proxy.local",
  };
  const accountsResult = await readAccounts(authDir);
  await readMergedQuotaSnapshots(paths, accountsResult.accounts, undefined, [], false);
}

describe("rotation evidence identity and Observation Continuity", () => {
  it("recognizes weekly-only Primary and keeps positional legacy display-only", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-weekly-primary@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { refresh_token: "fixture-refresh-weekly" });
    const configPath = await writeConfig(root, authDir);
    stubModelList();
    await persistDashboardState(configPath, authDir);

    await writeQuotaResponseLog(logsDir, "v1-responses-weekly.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 18.25,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
    });
    await persistDashboardState(configPath, authDir);
    const semantic = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(semantic.accounts[0].quota.weekly).toMatchObject({
      status: "current",
      usedPercent: 18.25,
      durationMinutes: 10080,
      windowKind: "weekly",
      providerSlot: "primary",
      migrationOnly: false,
      continuity: "continuous",
      identityBound: true,
    });

    await rm(logsDir, { recursive: true, force: true });
    await writeQuotaResponseLog(logsDir, "v1-responses-legacy.log", fileName, {
      timestamp: new Date(Date.now() + 1000).toISOString(),
      primaryUsedPercent: 7,
      primaryResetAfterSeconds: 3600,
    });
    const legacy = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(legacy.accounts[0].quota.primary5h).toMatchObject({ usedPercent: 7, migrationOnly: true, identityBound: false });
    expect(legacy.accounts[0].quota.weekly).toMatchObject({ usedPercent: 18.25, status: "stale", continuity: "broken" });
  });

  it("blocks retained rotation authority after credential replacement under same filename", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-replaced@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { refresh_token: "fixture-refresh-before" });
    const configPath = await writeConfig(root, authDir);
    stubModelList();
    await persistDashboardState(configPath, authDir);
    await writeQuotaResponseLog(logsDir, "v1-responses-before.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 22,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
    });
    await persistDashboardState(configPath, authDir);
    const first = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(first.accounts[0].quota.weekly.status).toBe("current");

      const accountPath = path.join(authDir, fileName);
      const replacement = JSON.parse(await readFile(accountPath, "utf8"));
      replacement.refresh_token = "fixture-refresh-after";
      await writeFile(accountPath, `${JSON.stringify(replacement, null, 2)}\n`);

      const refreshed = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
      expect(refreshed.accounts[0].quota.weekly).toMatchObject({ usedPercent: 22, status: "current", continuity: "continuous", identityBound: true });

      replacement.account_id = "acct-fixture-replacement";
      replacement.email = "replacement@example.com";
      await writeFile(accountPath, `${JSON.stringify(replacement, null, 2)}\n`);

      const replaced = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(replaced.accounts[0].quota.weekly).toMatchObject({ usedPercent: 22, status: "stale", continuity: "broken", identityBound: false });

    await writeQuotaResponseLog(logsDir, "v1-responses-after.log", fileName, {
      timestamp: new Date(Date.now() + 1000).toISOString(),
      primaryUsedPercent: 6,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
    });
    await persistDashboardState(configPath, authDir);
    const rebound = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(rebound.accounts[0].quota.weekly).toMatchObject({ usedPercent: 6, status: "current", continuity: "continuous", identityBound: true });
  });

  it("does not bind historical logs to replacement credentials on a cold state store", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-cold-replaced@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { refresh_token: "fixture-refresh-cold-before" });
    const configPath = await writeConfig(root, authDir);
    stubModelList();
    await writeQuotaResponseLog(logsDir, "v1-responses-cold-before.log", fileName, {
      timestamp: new Date(Date.now() - 10_000).toISOString(),
      primaryUsedPercent: 31,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
    });
    await persistDashboardState(configPath, authDir);
      const accountPath = path.join(authDir, fileName);
      const replacement = JSON.parse(await readFile(accountPath, "utf8"));
      replacement.refresh_token = "fixture-refresh-cold-after";
      replacement.account_id = "acct-fixture-cold-replacement";
      replacement.email = "cold-replacement@example.com";
      await writeFile(accountPath, `${JSON.stringify(replacement, null, 2)}\n`);

    const cold = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(cold.accounts[0].quota.weekly).toMatchObject({ usedPercent: 31, status: "stale", continuity: "broken", identityBound: false });
  });

  it("breaks continuity when later routed evidence has no usable quota headers", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-gap@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { refresh_token: "fixture-refresh-gap" });
    const configPath = await writeConfig(root, authDir);
    stubModelList();
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    await writeQuotaResponseLog(logsDir, "v1-responses-good.log", fileName, {
      timestamp: new Date(Date.now() + 1000).toISOString(),
      primaryUsedPercent: 12,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
    });
    await persistDashboardState(configPath, authDir);
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });

    await mkdir(logsDir, { recursive: true });
    await writeFile(
      path.join(logsDir, "v1-responses-missing.log"),
      `${responseLogFixture(fileName, { timestamp: new Date(Date.now() + 2000).toISOString() })}\nHTTP/1.1 200 OK\n`,
    );
    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(state.accounts[0].quota.weekly).toMatchObject({ usedPercent: 12, status: "stale", continuity: "broken" });
  });

  it("keeps semantic evidence rotation-unbound when credential identity cannot be proven", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-unverified@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { account_id: "", email: "", refresh_token: "", id_token: "" });
    const configPath = await writeConfig(root, authDir);
    stubModelList();
    await writeQuotaResponseLog(logsDir, "v1-responses-unverified.log", fileName, {
      timestamp: new Date().toISOString(),
      primaryUsedPercent: 11,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
    });
    await persistDashboardState(configPath, authDir);
    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(state.accounts[0].quota.weekly).toMatchObject({ usedPercent: 11, identityBound: false });
  });

  it("breaks continuity when a completed routed request has no response observation file", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-dropped@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { refresh_token: "fixture-refresh-dropped" });
    const configPath = await writeConfig(root, authDir);
    stubModelList();
    await persistDashboardState(configPath, authDir);
    const base = Date.now();
    await writeQuotaResponseLog(logsDir, "v1-responses-before-drop.log", fileName, {
      timestamp: new Date(base + 1000).toISOString(),
      primaryUsedPercent: 14,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
    });
    await persistDashboardState(configPath, authDir);
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });

    await rm(logsDir, { recursive: true, force: true });
    await mkdir(logsDir, { recursive: true });
    await writeFile(path.join(logsDir, "main.log"), [
      `[${new Date(base + 2000).toISOString()}] [trace-drop] [info ] [selector.go:500] selected | session=msg:drop auth=${fileName} provider=codex model=gpt-5.4-mini`,
      `[${new Date(base + 3000).toISOString()}] [trace-drop] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"`,
      "",
    ].join("\n"));
    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(state.accounts[0].quota.weekly).toMatchObject({ usedPercent: 14, status: "stale", continuity: "broken" });
  });

  it("does not let a later valid response hide an earlier missing observation", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const fileName = "codex-sequence-gap@example.com-plus.json";
    await writeAccountFile(authDir, fileName, { refresh_token: "fixture-refresh-sequence" });
    const configPath = await writeConfig(root, authDir);
    stubModelList();
    await persistDashboardState(configPath, authDir);
    const base = Date.now();
    await writeQuotaResponseLog(logsDir, "v1-responses-sequence-base.log", fileName, {
      timestamp: new Date(base + 1000).toISOString(),
      primaryUsedPercent: 10,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
      traceId: "trace-base",
    });
    await persistDashboardState(configPath, authDir);
    await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });

    await rm(logsDir, { recursive: true, force: true });
    await mkdir(logsDir, { recursive: true });
    await writeQuotaResponseLog(logsDir, "v1-responses-sequence-later.log", fileName, {
      timestamp: new Date(base + 5000).toISOString(),
      primaryUsedPercent: 12,
      primaryResetAfterSeconds: 604800,
      primaryDurationMinutes: 10080,
      traceId: "trace-later",
    });
    await writeFile(path.join(logsDir, "main.log"), [
      `[${new Date(base + 2000).toISOString()}] [trace-missing] [info ] [selector.go:500] selected | session=msg:missing auth=${fileName} provider=codex model=gpt-5.4-mini`,
      `[${new Date(base + 3000).toISOString()}] [trace-missing] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"`,
      `[${new Date(base + 4000).toISOString()}] [trace-later] [info ] [selector.go:500] selected | session=msg:later auth=${fileName} provider=codex model=gpt-5.4-mini`,
      `[${new Date(base + 6000).toISOString()}] [trace-later] [info ] [gin_logger.go:94] 200 | 2.000s | 127.0.0.1 | POST "/v1/responses"`,
      "",
    ].join("\n"));
    const state = await readDashboardState({ configPath, proxyUrl: "http://proxy.local", inboundKey: "key" });
    expect(state.accounts[0].quota.weekly).toMatchObject({ usedPercent: 12, status: "stale", continuity: "broken" });
  });

  it("reconciles completed routes beyond UI's recent-log limit", async () => {
    const root = await makeTempRoot();
    const mainLogPath = path.join(root, "main.log");
    const lines: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const traceId = `trace-${index}`;
      lines.push(`[2026-07-15T00:00:${String(index).padStart(2, "0")}.000Z] [${traceId}] [info ] [selector.go:500] selected | session=msg:${index} auth=codex-${index}.json provider=codex model=gpt-5.4-mini`);
      lines.push(`[2026-07-15T00:01:${String(index).padStart(2, "0")}.000Z] [${traceId}] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"`);
    }
    await writeFile(mainLogPath, `${lines.join("\n")}\n`);
    const completed = await readCompletedCodexRoutes(mainLogPath);
    expect(completed).toHaveLength(30);
    expect(completed.some((route) => route.traceId === "trace-0")).toBe(true);
  });
});
