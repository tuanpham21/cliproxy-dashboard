import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readDashboardState } from "../dashboard-state.js";
import { createRotationCoordinator } from "../rotation-coordinator.js";
import { createRotationLogObserver, type RotationObservationBatch } from "../rotation-log-observer.js";
import { makeTempRoot, stubModelList, writeAccountFile, writeConfig, writeQuotaResponseLog } from "./helpers.js";

async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for rotation observation");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture() {
  const root = await makeTempRoot();
  const authDir = path.join(root, "auth");
  const logsDir = path.join(authDir, "logs");
  const fileName = "codex-observer@example.com.json";
  await writeAccountFile(authDir, fileName);
  const configPath = await writeConfig(root, authDir);
  return {
    root,
    authDir,
    logsDir,
    fileName,
    configPath,
    dashboardOptions: { configPath, authDir, proxyUrl: "http://proxy.local", inboundKey: "key" },
    cursorPath: path.join(root, "rotation-observer-cursor.json"),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("rotation log observer", () => {
  it("wakes the production decision coordinator while the browser is closed", async () => {
    const test = await fixture();
    const coordinator = await createRotationCoordinator(test.dashboardOptions);
    const observer = await createRotationLogObserver(test.dashboardOptions, {
      statePath: test.cursorPath,
      debounceMs: 15,
      reconcileMs: 60_000,
      onObservation: (batch) => coordinator.handleObservation(batch),
    });
    await observer.start();
    await writeQuotaResponseLog(test.logsDir, "v1-responses-production-wake.log", test.fileName, {
      timestamp: new Date(Date.now() + 1_000).toISOString(),
      weeklyUsedPercent: 20,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-production-wake",
    });

    await waitFor(() => coordinator.state().audit.some((event) => event.kind === "decision"));
    expect(coordinator.state()).toMatchObject({ mode: "off", lifecycle: "off" });
    expect(coordinator.state().audit.at(-1)).toMatchObject({ kind: "decision", message: "rotation is off" });
    await observer.close();
    await coordinator.close();
  });

  it("wakes without browser reads, debounces filesystem changes, deduplicates evidence, and marks missing weekly evidence uncertain", async () => {
    const test = await fixture();
    const batches: RotationObservationBatch[] = [];
    const observer = await createRotationLogObserver(test.dashboardOptions, {
      statePath: test.cursorPath,
      debounceMs: 15,
      reconcileMs: 60_000,
      onObservation: (batch) => { batches.push(batch); },
    });
    await observer.start();
    const weeklyTimestamp = new Date(Date.now() + 1_000).toISOString();
    await writeQuotaResponseLog(test.logsDir, "v1-responses-observer-weekly.log", test.fileName, {
      timestamp: weeklyTimestamp,
      primaryUsedPercent: 10,
      primaryResetAfterSeconds: 18_000,
      primaryDurationMinutes: 300,
      weeklyUsedPercent: 20,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-weekly",
    });
    await waitFor(() => batches.flatMap((batch) => batch.updates).length === 1);
    const weekly = batches.flatMap((batch) => batch.updates)[0];
    expect(weekly).toMatchObject({ observedAt: weeklyTimestamp, continuity: "continuous", routeTraceId: "trace-weekly" });
    expect(weekly.weekly).toMatchObject({ usedPercent: 20, observedAt: weeklyTimestamp, windowKind: "weekly" });

    await writeQuotaResponseLog(test.logsDir, "v1-responses-observer-weekly.log", test.fileName, {
      timestamp: weeklyTimestamp,
      primaryUsedPercent: 10,
      primaryResetAfterSeconds: 18_000,
      primaryDurationMinutes: 300,
      weeklyUsedPercent: 20,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-weekly",
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(batches.flatMap((batch) => batch.updates)).toHaveLength(1);

    await writeQuotaResponseLog(test.logsDir, "v1-responses-observer-no-weekly.log", test.fileName, {
      timestamp: new Date(Date.now() + 2_000).toISOString(),
      primaryUsedPercent: 12,
      primaryResetAfterSeconds: 18_000,
      primaryDurationMinutes: 300,
      traceId: "trace-no-weekly",
    });
    await waitFor(() => batches.flatMap((batch) => batch.updates).length === 2);
    expect(batches.flatMap((batch) => batch.updates)[1]).toMatchObject({ continuity: "uncertain", routeTraceId: "trace-no-weekly" });
    await observer.close();
  });

  it("uses persisted bounded cursors for restart overlap and dropped-event reconciliation", async () => {
    const test = await fixture();
    const firstBatches: RotationObservationBatch[] = [];
    const first = await createRotationLogObserver(test.dashboardOptions, {
      statePath: test.cursorPath,
      maxSeenIds: 2,
      onObservation: (batch) => { firstBatches.push(batch); },
    });
    await first.reconcile(true);
    for (let index = 0; index < 3; index += 1) {
      await writeQuotaResponseLog(test.logsDir, `v1-responses-reconcile-${index}.log`, test.fileName, {
        timestamp: new Date(Date.now() + 1_000 + index).toISOString(),
        weeklyUsedPercent: 20 + index,
        weeklyResetAfterSeconds: 604_800,
        secondaryDurationMinutes: 10_080,
        traceId: `trace-reconcile-${index}`,
      });
      await first.reconcile();
    }
    expect(firstBatches.flatMap((batch) => batch.updates)).toHaveLength(3);
    await first.close();

    const restartedBatches: RotationObservationBatch[] = [];
    const restarted = await createRotationLogObserver(test.dashboardOptions, {
      statePath: test.cursorPath,
      maxSeenIds: 2,
      onObservation: (batch) => { restartedBatches.push(batch); },
    });
    await restarted.reconcile(true);
    expect(restartedBatches.flatMap((batch) => batch.updates)).toHaveLength(0);

    await writeQuotaResponseLog(test.logsDir, "v1-responses-dropped-event.log", test.fileName, {
      timestamp: new Date(Date.now() + 5_000).toISOString(),
      weeklyUsedPercent: 30,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-dropped-event",
    });
    await restarted.reconcile();
    expect(restartedBatches.flatMap((batch) => batch.updates)).toHaveLength(1);
    const cursor = JSON.parse(await readFile(test.cursorPath, "utf8"));
    expect(cursor.seenObservationIds).toHaveLength(2);
    expect(Object.keys(cursor.responseFiles).length).toBeLessThanOrEqual(256);
    await restarted.close();
  });

  it("handles append, truncation, concurrent responses, completed routes, and out-of-order quota evidence", async () => {
    const test = await fixture();
    stubModelList();
    const batches: RotationObservationBatch[] = [];
    const observer = await createRotationLogObserver(test.dashboardOptions, {
      statePath: test.cursorPath,
      debounceMs: 15,
      reconcileMs: 60_000,
      onObservation: (batch) => { batches.push(batch); },
    });
    await observer.start();
    const mainLogPath = path.join(test.logsDir, "main.log");
    await writeFile(mainLogPath, [
      `[2026-07-16T00:00:00.000Z] [trace-route-1] [info ] [selector.go:500] selected | session=msg:1 auth=${test.fileName} provider=codex model=gpt-5.4-mini`,
      `[2026-07-16T00:00:01.000Z] [trace-route-1] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"`,
      "",
    ].join("\n"));
    await waitFor(() => batches.flatMap((batch) => batch.completedRoutes).some((route) => route.traceId === "trace-route-1"));

    await appendFile(mainLogPath, [
      `[2026-07-16T00:00:02.000Z] [trace-route-2] [info ] [selector.go:500] selected | session=msg:2 auth=${test.fileName} provider=codex model=gpt-5.4-mini`,
      `[2026-07-16T00:00:03.000Z] [trace-route-2] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"`,
      "",
    ].join("\n"));
    await waitFor(() => batches.flatMap((batch) => batch.completedRoutes).some((route) => route.traceId === "trace-route-2"));

    await writeFile(mainLogPath, [
      `[2026-07-16T00:00:04.000Z] [trace-route-3] [info ] [selector.go:500] selected | session=msg:3 auth=${test.fileName} provider=codex model=gpt-5.4-mini`,
      `[2026-07-16T00:00:05.000Z] [trace-route-3] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"`,
      "",
    ].join("\n"));
    await waitFor(() => batches.flatMap((batch) => batch.completedRoutes).some((route) => route.traceId === "trace-route-3"));

    const newerTimestamp = new Date(Date.now() + 10_000).toISOString();
    const olderTimestamp = new Date(Date.now() + 5_000).toISOString();
    await Promise.all([
      writeQuotaResponseLog(test.logsDir, "v1-responses-concurrent-newer.log", test.fileName, {
        timestamp: newerTimestamp,
        weeklyUsedPercent: 55,
        weeklyResetAfterSeconds: 604_800,
        secondaryDurationMinutes: 10_080,
        traceId: "trace-concurrent-newer",
      }),
      writeQuotaResponseLog(test.logsDir, "v1-responses-concurrent-older.log", test.fileName, {
        timestamp: olderTimestamp,
        weeklyUsedPercent: 5,
        weeklyResetAfterSeconds: 604_800,
        secondaryDurationMinutes: 10_080,
        traceId: "trace-concurrent-older",
      }),
    ]);
    await Promise.all([observer.reconcile(), observer.reconcile()]);
    const updateIds = batches.flatMap((batch) => batch.updates).map((update) => update.observationId);
    expect(new Set(updateIds).size).toBe(updateIds.length);
    const state = await readDashboardState(test.dashboardOptions);
    expect(state.accounts[0].quota.weekly).toMatchObject({ usedPercent: 55 });
    await observer.close();
  });

  it("retries controller wake failures and drains changed files beyond the per-scan cap", async () => {
    const test = await fixture();
    let attempts = 0;
    const successfulObservationIds: string[] = [];
    const observer = await createRotationLogObserver(test.dashboardOptions, {
      statePath: test.cursorPath,
      maxFilesPerScan: 1,
      onObservation: (batch) => {
        attempts += 1;
        if (attempts === 1) throw new Error("synthetic controller wake failure");
        successfulObservationIds.push(...batch.updates.flatMap((update) => update.observationId ? [update.observationId] : []));
      },
    });
    await observer.reconcile(true);
    await Promise.all([
      writeQuotaResponseLog(test.logsDir, "v1-responses-backlog-a.log", test.fileName, {
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        weeklyUsedPercent: 21,
        weeklyResetAfterSeconds: 604_800,
        secondaryDurationMinutes: 10_080,
      }),
      writeQuotaResponseLog(test.logsDir, "v1-responses-backlog-b.log", test.fileName, {
        timestamp: new Date(Date.now() + 2_000).toISOString(),
        weeklyUsedPercent: 22,
        weeklyResetAfterSeconds: 604_800,
        secondaryDurationMinutes: 10_080,
      }),
    ]);

    await observer.reconcile();
    await observer.reconcile();
    await observer.reconcile();
    expect(attempts).toBe(3);
    expect(new Set(successfulObservationIds).size).toBe(2);
    await observer.close();
  });

  it("fails closed on bounded response/main-log overflow and reports each unchanged gap once", async () => {
    const test = await fixture();
    const batches: RotationObservationBatch[] = [];
    const observer = await createRotationLogObserver(test.dashboardOptions, {
      statePath: test.cursorPath,
      maxTrackedFiles: 1,
      maxMainLogReadBytes: 128,
      mainLogOverlapBytes: 1_024,
      onObservation: (batch) => { batches.push(batch); },
    });
    await observer.reconcile(true);
    batches.length = 0;
    await Promise.all([
      writeQuotaResponseLog(test.logsDir, "v1-responses-overflow-a.log", test.fileName, {
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        weeklyUsedPercent: 31,
        weeklyResetAfterSeconds: 604_800,
        secondaryDurationMinutes: 10_080,
      }),
      writeQuotaResponseLog(test.logsDir, "v1-responses-overflow-b.log", test.fileName, {
        timestamp: new Date(Date.now() + 2_000).toISOString(),
        weeklyUsedPercent: 32,
        weeklyResetAfterSeconds: 604_800,
        secondaryDurationMinutes: 10_080,
      }),
    ]);
    await writeFile(path.join(test.logsDir, "main.log"), `${"padding".repeat(80)}\n`);

    await observer.reconcile();
    expect(batches).toHaveLength(1);
    expect(batches[0].errors.join("\n")).toMatch(/cursor overflow/i);
    expect(batches[0].errors.join("\n")).toMatch(/bounded overlap/i);
    await observer.reconcile();
    expect(batches).toHaveLength(1);
    await observer.close();
  });
});
