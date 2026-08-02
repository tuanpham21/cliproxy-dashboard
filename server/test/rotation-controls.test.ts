import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { readAccounts } from "../accounts.js";
import { handleApi } from "../api.js";
import { readDashboardState } from "../dashboard-state.js";
import { readMergedQuotaSnapshots } from "../quota-log-updates.js";
import { resolveDashboardPaths } from "../paths.js";
import { openRotationController } from "../rotation-controller.js";
import { createRotationCoordinator, RotationCoordinator } from "../rotation-coordinator.js";
import { coordinateManualRoutingAction } from "../rotation-api.js";
import { TEST_OPERATOR_TOKEN, makeMockRes, makeTempRoot, sameOriginHeaders, writeAccountFile, writeConfig } from "./helpers.js";

function request(method: string, url: string, body?: Record<string, unknown>): IncomingMessage {
  const req = Readable.from(body ? [JSON.stringify(body)] : []) as unknown as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = sameOriginHeaders(true);
  return req;
}

async function initializeQuotaSnapshotStore(configPath: string, authDir: string): Promise<void> {
  const paths = await resolveDashboardPaths({ configPath, authDir });
  const accountsResult = await readAccounts(authDir);
  await readMergedQuotaSnapshots(paths, accountsResult.accounts, undefined, [], false);
}

describe("rotation controls", () => {
  it("rejects production manual writes while rotation coordinator startup is incomplete", async () => {
    await expect(coordinateManualRoutingAction(null as never, "synthetic manual write")).rejects.toThrow(/startup.*incomplete/i);
  });

  it("validates pool Proxy Account Key to filename mapping", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const rotationController = await openRotationController({ statePath: path.join(root, "pool-mapping.json") });
    const coordinator = new RotationCoordinator(authDir, rotationController, {
      proxyAccountKeyResolver: () => "pak_v1_expected",
    });

    await expect(coordinator.upsertPoolMember({
      proxyAccountKey: "pak_v1_wrong",
      fileName: "codex-fixture.json",
      exclusivityAttested: true,
    })).rejects.toThrow(/Proxy Account Key.*file name/i);
    expect(coordinator.publicState().pool).toEqual([]);
    await coordinator.close();
  });

  it("serializes concurrent Rotation Pool updates without losing members", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const rotationController = await openRotationController({ statePath: path.join(root, "pool-concurrency.json") });
    const coordinator = new RotationCoordinator(authDir, rotationController);

    await Promise.all([
      coordinator.upsertPoolMember({ proxyAccountKey: "pak-a", fileName: "codex-a.json", exclusivityAttested: true }),
      coordinator.upsertPoolMember({ proxyAccountKey: "pak-b", fileName: "codex-b.json", exclusivityAttested: true }),
    ]);
    expect(coordinator.publicState().pool.map((member) => member.proxyAccountKey).sort()).toEqual(["pak-a", "pak-b"]);
    await coordinator.close();
  });

  it("rejects active mode when routing prerequisites are incompatible", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const statePath = path.join(root, "incompatible-rotation.json");
    const rotationController = await openRotationController({ statePath });
    const coordinator = new RotationCoordinator(
      authDir,
      rotationController,
      { canMutate: true, readinessCheck: async () => ({ compatible: false, reason: "fill-first routing with session affinity disabled is required" }) },
    );

    await expect(coordinator.setMode("active")).rejects.toThrow(/fill-first.*session affinity/i);
    expect(coordinator.publicState()).toMatchObject({ routingCompatible: false, canActivate: false, mode: "off" });
    await coordinator.close();
  });

  it("manages Rotation Pool, shadow mode, Manual Hold, resume, pause, and active-mode gate", async () => {
    const root = await makeTempRoot();
      const authDir = path.join(root, "auth");
      const configPath = await writeConfig(root, authDir);
      await writeAccountFile(authDir, "codex-fixture.json", { validity_status: "valid" });
      await initializeQuotaSnapshotStore(configPath, authDir);
      const coordinator = await createRotationCoordinator({ configPath, authDir });
      const proxyAccountKey = (await readDashboardState({ configPath, authDir })).accounts[0]?.proxyAccountKey;
      if (!proxyAccountKey) throw new Error("synthetic Proxy Account Key unavailable");

      expect(coordinator.publicState()).toMatchObject({ mode: "off", lifecycle: "off", eligibleCount: 0, provisionalCount: 0, canActivate: false });
      await coordinator.upsertPoolMember({ proxyAccountKey, fileName: "codex-fixture.json", exclusivityAttested: true });
    await coordinator.setMode("shadow");
    expect(coordinator.publicState()).toMatchObject({
      mode: "shadow",
      lifecycle: "shadow",
        pool: [{ proxyAccountKey, fileName: "codex-fixture.json", exclusivityAttested: true }],
    });

    await coordinator.enterManualHold("Manual Primary selected by operator");
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "manual-hold", manualHold: true });
    await coordinator.resume();
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "shadow", manualHold: false, restorationVerified: true });
      await coordinator.pause("Synthetic operator pause");
      expect(coordinator.publicState()).toMatchObject({ lifecycle: "paused", pauseMessage: "Synthetic operator pause" });
      await coordinator.setMode("shadow");
      expect(coordinator.publicState()).toMatchObject({ lifecycle: "paused", pauseMessage: "Synthetic operator pause" });
      await coordinator.resume();
    expect(coordinator.publicState().audit.map((event) => event.kind)).toEqual(expect.arrayContaining(["observation", "resume", "hold", "decision"]));
    await expect(coordinator.setMode("active")).rejects.toThrow(/management key/i);
      await coordinator.removePoolMember(proxyAccountKey);
      expect(coordinator.publicState().pool).toEqual([]);
    await coordinator.close();
  });

  it("rejects legacy all-enabled-codex pool mode", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const configPath = await writeConfig(root, authDir);
    await writeAccountFile(authDir, "codex-alpha-pro.json", { validity_status: "valid" });
    const coordinator = await createRotationCoordinator({ configPath, authDir });

    await expect(coordinator.setPoolMode("all-enabled-codex" as never)).rejects.toThrow(/all-enabled-codex pool mode is no longer supported/i);
    expect(coordinator.publicState().poolMode).toBe("manual");
    await coordinator.close();
  });

  it("rejects legacy all-enabled-codex pool mode through the HTTP API", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const configPath = await writeConfig(root, authDir);
    await writeAccountFile(authDir, "codex-alpha-pro.json", { validity_status: "valid" });
    const coordinator = await createRotationCoordinator({ configPath, authDir });
    const response = makeMockRes();

    await handleApi(
      request("POST", "/api/rotation/pool-mode", { poolMode: "all-enabled-codex", exclusivityAttested: true }),
      response.res as unknown as ServerResponse,
      {
        configPath,
        authDir,
        operatorToken: TEST_OPERATOR_TOKEN,
        host: "127.0.0.1",
        rotationCoordinator: coordinator,
      },
    );

    expect(response.getStatus()).toBe(400);
    expect(response.getParsed().error).toMatch(/all-enabled-codex pool mode is no longer supported/i);
    expect(coordinator.publicState()).toMatchObject({ poolMode: "manual", pool: [] });
    await coordinator.close();
  });

  it("exposes rotation API and coordinates manual priority changes through Manual Hold", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const backupRoot = path.join(root, "backups");
    const fileName = "codex-controls@example.com.json";
    await writeAccountFile(authDir, fileName, { priority: 10 });
    const configPath = await writeConfig(root, authDir);
      await initializeQuotaSnapshotStore(configPath, authDir);
      const coordinator = await createRotationCoordinator({ configPath, authDir });
      const proxyAccountKey = (await readDashboardState({ configPath, authDir })).accounts[0]?.proxyAccountKey;
      if (!proxyAccountKey) throw new Error("synthetic Proxy Account Key unavailable");
    const options = {
      configPath,
      authDir,
      backupRoot,
      operatorToken: TEST_OPERATOR_TOKEN,
      host: "127.0.0.1",
      rotationCoordinator: coordinator,
    };

    let response = makeMockRes();
    await handleApi(request("POST", "/api/rotation/mode", { mode: "shadow" }), response.res as unknown as ServerResponse, options);
    expect(response.getStatus()).toBe(200);
    expect(JSON.parse(response.getBody()).rotation).toMatchObject({ mode: "shadow", lifecycle: "shadow" });

    response = makeMockRes();
      await handleApi(request("PUT", `/api/rotation/pool/${encodeURIComponent(proxyAccountKey)}`, {
      fileName,
      exclusivityAttested: true,
    }), response.res as unknown as ServerResponse, options);
      expect(response.getStatus()).toBe(200);
      expect(coordinator.publicState().pool).toHaveLength(1);

      response = makeMockRes();
      await handleApi(request("POST", "/api/routing", { strategy: "failover", sessionAffinity: false }), response.res as unknown as ServerResponse, options);
      expect(response.getStatus()).toBe(200);
      expect(coordinator.publicState()).toMatchObject({ routingCompatible: false, canActivate: false, lifecycle: "manual-hold" });

      response = makeMockRes();
    await handleApi(request("PATCH", `/api/accounts/${encodeURIComponent(fileName)}`, { priority: 42 }), response.res as unknown as ServerResponse, options);
    expect(response.getStatus()).toBe(200);
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "manual-hold", manualHold: true });

    response = makeMockRes();
      await handleApi(request("POST", "/api/rotation/resume"), response.res as unknown as ServerResponse, options);
      expect(response.getStatus()).toBe(200);
      expect(coordinator.publicState()).toMatchObject({ lifecycle: "shadow", manualHold: false });

      response = makeMockRes();
      await handleApi(request("POST", "/api/rotation/pause", { message: "Synthetic recovery drill" }), response.res as unknown as ServerResponse, options);
      expect(response.getStatus()).toBe(200);
      response = makeMockRes();
      await handleApi(request("POST", "/api/rotation/recover"), response.res as unknown as ServerResponse, options);
      expect(response.getStatus()).toBe(200);
      expect(coordinator.publicState()).toMatchObject({ mode: "off", lifecycle: "off", restorationVerified: true });
      await coordinator.close();
  });
});
