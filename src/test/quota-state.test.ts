import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  DEFAULT_DASHBOARD_PORT,
  buildOpenUrlCommand,
  buildStuckOauthCleanupCommand,
  defaultCliProxyBin,
  handleApi,
  parseCliArgs,
  readDashboardState,
  resolveCliProxyBin,
  setAccountPatch,
  setRoutingConfig,
  sortAccounts,
} from "../cliproxy-dashboard.js";
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


describe("cliproxy dashboard quota state", () => {
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

});
