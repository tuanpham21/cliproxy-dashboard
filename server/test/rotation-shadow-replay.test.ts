import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readDashboardState } from "../dashboard-state.js";
import { openRotationController } from "../rotation-controller.js";
import { createRotationCoordinator, RotationCoordinator } from "../rotation-coordinator.js";
import { createRotationLogObserver, type RotationObservationBatch } from "../rotation-log-observer.js";
import { decideRotation } from "../rotation-policy.js";
import { MAX_EVIDENCE_WATERMARK_OBSERVATION_IDS } from "../rotation-types.js";
import type { RotationAccountSnapshot, RotationPriorityWriter } from "../rotation-types.js";
import type { PersistedQuotaSnapshot } from "../types.js";
import { makeTempRoot, stubModelList, writeAccountFile, writeConfig, writeQuotaResponseLog } from "./helpers.js";

type ManagedProxyAccount = Awaited<ReturnType<RotationPriorityWriter["readAccounts"]>>[number];

class NoWritePriorityWriter implements RotationPriorityWriter {
  setCalls = 0;
  restoreCalls = 0;

  async readAccounts(): Promise<ManagedProxyAccount[]> {
    return [
      managedAccount("account-a", 10),
      managedAccount("account-b", 5),
    ];
  }

  async setTargetPriority(): Promise<never> {
    this.setCalls += 1;
    throw new Error("shadow replay must not enter CLIProxy mutation");
  }

  async restoreBasePriorities(): Promise<void> {
    this.restoreCalls += 1;
    throw new Error("shadow replay must not restore priorities");
  }
}

function managedAccount(proxyAccountKey: string, priority: number): ManagedProxyAccount {
  return {
    proxyAccountKey,
    fileName: `codex-${proxyAccountKey}.json`,
    priority,
    explicitPriority: true,
    revision: `revision-${proxyAccountKey}`,
    fingerprint: `fingerprint-${proxyAccountKey}`,
    disabled: false,
    note: `note-${proxyAccountKey}`,
  };
}

function snapshot(
  proxyAccountKey: string,
  usedPercent: number,
  observedAt: string,
  overrides: Partial<PersistedQuotaSnapshot> = {},
): PersistedQuotaSnapshot {
  const credentialFingerprint = `fingerprint-${proxyAccountKey}`;
  const observationId = `observation-${proxyAccountKey}-${observedAt}`;
  return {
    proxyAccountKey,
    credentialFingerprint,
    observationContinuity: "continuous",
    lastObservationId: observationId,
    lastObservationAt: observedAt,
    weekly: {
      usedPercent,
      rawUsedPercent: usedPercent,
      resetAt: "2026-07-20T00:00:00.000Z",
      observedAt,
      source: "response-header",
      durationMinutes: 10_080,
      windowKind: "weekly",
      evidenceId: `evidence-${proxyAccountKey}-${observedAt}`,
      credentialFingerprint,
      continuity: "continuous",
      schemaVersion: 2,
    },
    ...overrides,
  };
}

function batch(
  observedKey: "account-a" | "account-b",
  observedAt: string,
  snapshots: PersistedQuotaSnapshot[],
): RotationObservationBatch {
  const canonicalLocalIdentity = `codex-${observedKey}.json`;
  const traceId = `trace-${observedKey}-${observedAt}`;
  const observed = snapshots.find((candidate) => candidate.proxyAccountKey === observedKey);
  return {
    updates: observed?.weekly
      ? [{
          canonicalLocalIdentity,
          weekly: observed.weekly,
          continuity: observed.observationContinuity,
          observationId: observed.lastObservationId,
          observedAt,
          routeTraceId: traceId,
        }]
      : [],
    completedRoutes: [{ canonicalLocalIdentity, observedAt, traceId }],
    snapshotsByCanonicalIdentity: new Map(snapshots.map((candidate) => [`codex-${candidate.proxyAccountKey}.json`, candidate])),
    errors: [],
    observedAt,
  };
}

async function shadowHarness(root: string, writer: NoWritePriorityWriter) {
  const authDir = path.join(root, "auth");
  await writeAccountFile(authDir, "codex-account-a.json", { priority: 10, validity_status: "valid" });
  await writeAccountFile(authDir, "codex-account-b.json", { priority: 5, validity_status: "valid" });
  const controller = await openRotationController({ statePath: path.join(root, "rotation-shadow.json"), writer, mode: "shadow" });
  const coordinator = new RotationCoordinator(authDir, controller);
  if (coordinator.publicState().pool.length === 0) {
    await coordinator.upsertPoolMember({ proxyAccountKey: "account-a", fileName: "codex-account-a.json", exclusivityAttested: true });
    await coordinator.upsertPoolMember({ proxyAccountKey: "account-b", fileName: "codex-account-b.json", exclusivityAttested: true });
  }
  return coordinator;
}

function policyAccount(proxyAccountKey: string, usedPercent: number, provisionalReset = false): RotationAccountSnapshot {
  return {
    proxyAccountKey,
    fileName: `codex-${proxyAccountKey}.json`,
    enabled: true,
    sessionValid: true,
    observable: true,
    observationContinuity: "continuous",
    rotationPoolMember: true,
    exclusivityAttested: true,
    identityFingerprint: `fingerprint-${proxyAccountKey}`,
    identityVerified: true,
    weekly: {
      usedPercent,
      resetAt: "2026-07-20T00:00:00.000Z",
      observedAt: "2026-07-16T00:00:00.000Z",
      durationMinutes: 10_080,
      windowKind: "weekly",
      evidenceId: `evidence-${proxyAccountKey}`,
      credentialFingerprint: `fingerprint-${proxyAccountKey}`,
      continuity: "continuous",
      schemaVersion: 2,
    },
    exhausted: false,
    provisionalReset,
  };
}

async function appendSelectedRoute(mainLogPath: string, fileName: string, traceId: string, selectedAt: string): Promise<void> {
  await appendFile(
    mainLogPath,
    `[${selectedAt}] [${traceId}] [info ] [selector.go:500] selected | session=msg:${traceId} auth=${fileName} provider=codex model=gpt-5.4-mini\n`,
  );
}

async function appendCompletedRoute(mainLogPath: string, fileName: string, traceId: string, observedAt: string): Promise<void> {
  await appendSelectedRoute(mainLogPath, fileName, traceId, observedAt);
  await appendFile(
    mainLogPath,
    `[${observedAt}] [${traceId}] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"\n`,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime("2026-07-16T00:00:00.000Z");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("shadow replay", () => {
  it("runs the production observer, parser, store, and coordinator path with measured zero-write evidence", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const mainLogPath = path.join(logsDir, "main.log");
    const configPath = await writeConfig(root, authDir);
    const accountAFile = "codex-shadow-a@example.com.json";
    const accountBFile = "codex-shadow-b@example.com.json";
    await writeAccountFile(authDir, accountAFile, { account_id: "acct-shadow-a", priority: 10, validity_status: "valid" });
    await writeAccountFile(authDir, accountBFile, { account_id: "acct-shadow-b", priority: 5, validity_status: "valid" });
    const dashboardOptions = { configPath, authDir, proxyUrl: "http://127.0.0.1:1", inboundKey: "synthetic-inbound-key" };

    stubModelList();
    const dashboardState = await readDashboardState(dashboardOptions);
    vi.unstubAllGlobals();
    const accountAKey = dashboardState.accounts.find((account) => account.fileName === accountAFile)?.proxyAccountKey;
    const accountBKey = dashboardState.accounts.find((account) => account.fileName === accountBFile)?.proxyAccountKey;
    if (!accountAKey || !accountBKey) throw new Error("synthetic Proxy Account Keys unavailable");

    const fetchEvidence = { managementRequests: 0, priorityWrites: 0, providerRequests: 0 };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (input instanceof Request ? input.method : init?.method ?? "GET").toUpperCase();
      if (url.startsWith("http://127.0.0.1:1/v0/management/")) {
        fetchEvidence.managementRequests += 1;
        if (method !== "GET" && method !== "HEAD") fetchEvidence.priorityWrites += 1;
        throw new Error(`blocked synthetic CLIProxy management request: ${method} ${url}`);
      }
      fetchEvidence.providerRequests += 1;
      throw new Error(`blocked provider request: ${method} ${url}`);
    }));

    const coordinator = await createRotationCoordinator({
      ...dashboardOptions,
      managementKey: "synthetic-local-management-key",
    });
    await coordinator.upsertPoolMember({ proxyAccountKey: accountAKey, fileName: accountAFile, exclusivityAttested: true });
    await coordinator.upsertPoolMember({ proxyAccountKey: accountBKey, fileName: accountBFile, exclusivityAttested: true });
    await coordinator.setMode("shadow");

    const recognizedWeeklyObservationIds: string[] = [];
    const completedRouteTraceIds: string[] = [];
    const executedScenarios: string[] = [];
    await mkdir(logsDir, { recursive: true });
    const observer = await createRotationLogObserver(dashboardOptions, {
      statePath: path.join(root, "rotation-shadow-observer-cursor.json"),
      onObservation: async (observationBatch) => {
        recognizedWeeklyObservationIds.push(...observationBatch.updates.flatMap((update) =>
          update.weekly && update.observationId ? [update.observationId] : []));
        completedRouteTraceIds.push(...observationBatch.completedRoutes.map((route) => route.traceId));
        await coordinator.handleObservation(observationBatch);
      },
    });
    await observer.reconcile(true);

    const credentialPaths = [accountAFile, accountBFile].map((fileName) => path.join(authDir, fileName));
    const credentialBytesBefore = await Promise.all(credentialPaths.map((filePath) => readFile(filePath)));
    const configBytesBefore = await readFile(configPath);
    const equalAt = new Date(Date.now() + 1_000).toISOString();

    await writeQuotaResponseLog(logsDir, "v1-responses-shadow-equal-a.log", accountAFile, {
      timestamp: equalAt,
      weeklyUsedPercent: 20,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-shadow-equal-a",
    });
    await appendCompletedRoute(mainLogPath, accountAFile, "trace-shadow-equal-a", equalAt);
    await observer.reconcile();

    await writeQuotaResponseLog(logsDir, "v1-responses-shadow-equal-b.log", accountBFile, {
      timestamp: equalAt,
      weeklyUsedPercent: 15,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-shadow-equal-b",
    });
    await appendCompletedRoute(mainLogPath, accountBFile, "trace-shadow-equal-b", equalAt);
    await observer.reconcile();
    executedScenarios.push("equal-time-unique-observations");

    const recognizedBeforeDuplicate = recognizedWeeklyObservationIds.length;
    await writeQuotaResponseLog(logsDir, "v1-responses-shadow-equal-a.log", accountAFile, {
      timestamp: equalAt,
      weeklyUsedPercent: 20,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-shadow-equal-a",
    });
    await observer.reconcile();
    expect(recognizedWeeklyObservationIds).toHaveLength(recognizedBeforeDuplicate);
    executedScenarios.push("duplicate-observation");

    const inFlightSelectedAt = new Date(Date.now() + 1_500).toISOString();
    await appendSelectedRoute(mainLogPath, accountAFile, "trace-shadow-in-flight", inFlightSelectedAt);
    const switchAt = new Date(Date.now() + 2_000).toISOString();
    await writeQuotaResponseLog(logsDir, "v1-responses-shadow-switch.log", accountAFile, {
      timestamp: switchAt,
      weeklyUsedPercent: 20,
      weeklyResetAfterSeconds: 604_800,
      secondaryDurationMinutes: 10_080,
      traceId: "trace-shadow-switch",
    });
    await appendCompletedRoute(mainLogPath, accountAFile, "trace-shadow-switch", switchAt);
    await observer.reconcile();
    executedScenarios.push("five-point-would-switch");

    const inFlightCompletedAt = new Date(Date.now() + 3_000).toISOString();
    await appendFile(
      mainLogPath,
      `[${inFlightCompletedAt}] [trace-shadow-in-flight] [info ] [gin_logger.go:94] 200 | 1.000s | 127.0.0.1 | POST "/v1/responses"\n`,
    );
      await observer.reconcile();
      executedScenarios.push("late-in-flight-completion");
      executedScenarios.push("management-writer-not-invoked");
      const websocketAt = new Date(Date.now() + 4_000).toISOString();
      await writeQuotaResponseLog(logsDir, "v1-responses-shadow-websocket.log", accountBFile, { timestamp: websocketAt, weeklyUsedPercent: 15, weeklyResetAfterSeconds: 604_800, secondaryDurationMinutes: 10_080, traceId: "trace-shadow-websocket" });
      await appendSelectedRoute(mainLogPath, accountBFile, "trace-shadow-websocket", websocketAt);
      await appendFile(mainLogPath, `[${websocketAt}] [trace-shadow-websocket] [info ] [gin_logger.go:94] 101 | 1.000s | 127.0.0.1 | GET "/v1/ws"\n`);
      await observer.reconcile();
      expect(completedRouteTraceIds).toContain("trace-shadow-websocket");
      executedScenarios.push("websocket-response-route");

    const credentialBytesAfter = await Promise.all(credentialPaths.map((filePath) => readFile(filePath)));
    const configBytesAfter = await readFile(configPath);
    const decisionEvents = coordinator.publicState().audit.filter((event) => event.kind === "decision");
    const decisionObservationIds = decisionEvents.flatMap((event) => event.observationId ? [event.observationId] : []);
    const switchTargets = decisionEvents.flatMap((event) =>
      event.message.includes("Quota Spread reached") && event.proxyAccountKey ? [event.proxyAccountKey] : []);
    const recognizedUnique = [...new Set(recognizedWeeklyObservationIds)];
    const report = {
      recognizedWeeklyObservations: recognizedUnique.length,
      recognizedObservationsConsumedOnce: recognizedUnique.every((observationId) =>
        decisionObservationIds.filter((candidate) => candidate === observationId).length === 1),
      duplicateDecisions: decisionObservationIds.length - new Set(decisionObservationIds).size,
      switchTargets,
      lateInFlightRouteConsumedOnce:
        completedRouteTraceIds.filter((traceId) => traceId === "trace-shadow-in-flight").length === 1
        && decisionObservationIds.filter((observationId) => observationId === "route_trace-shadow-in-flight").length === 1,
      managementWriterRequests: fetchEvidence.managementRequests,
      priorityWrites: fetchEvidence.priorityWrites,
      credentialWrites: credentialBytesAfter.filter((bytes, index) => !bytes.equals(credentialBytesBefore[index])).length,
      proxyConfigWrites: configBytesAfter.equals(configBytesBefore) ? 0 : 1,
      providerRequests: fetchEvidence.providerRequests,
      scenarios: executedScenarios,
    };

    expect(report).toEqual({
        recognizedWeeklyObservations: 4,
      recognizedObservationsConsumedOnce: true,
      duplicateDecisions: 0,
      switchTargets: [accountBKey],
      lateInFlightRouteConsumedOnce: true,
      managementWriterRequests: 0,
      priorityWrites: 0,
      credentialWrites: 0,
      proxyConfigWrites: 0,
      providerRequests: 0,
      scenarios: [
        "equal-time-unique-observations",
        "duplicate-observation",
        "five-point-would-switch",
          "late-in-flight-completion",
          "management-writer-not-invoked",
          "websocket-response-route",
        ],
    });
    await observer.close();
    await coordinator.close();
  });

  it("consumes distinct equal-time observations once", async () => {
    const root = await makeTempRoot();
    const writer = new NoWritePriorityWriter();
    const coordinator = await shadowHarness(root, writer);
    const observedAt = "2026-07-16T00:00:00.000Z";
    const snapshots = [snapshot("account-a", 20, observedAt), snapshot("account-b", 15, observedAt)];
    const accountA = batch("account-a", observedAt, snapshots);
    const accountB = batch("account-b", observedAt, snapshots);

    await coordinator.handleObservation(accountA);
    await coordinator.handleObservation(accountB);
    expect(coordinator.publicState().audit.filter((event) => event.kind === "decision")).toHaveLength(2);

    await coordinator.handleObservation(accountA);
    await coordinator.handleObservation(accountB);
    expect(coordinator.publicState().audit.filter((event) => event.kind === "decision")).toHaveLength(2);
    await coordinator.close();
  });

  it("consumes every recognized weekly observation in one concurrent batch once", async () => {
    const root = await makeTempRoot();
    const writer = new NoWritePriorityWriter();
    const coordinator = await shadowHarness(root, writer);
    const observedAt = "2026-07-16T00:00:00.000Z";
    const snapshots = [snapshot("account-a", 20, observedAt), snapshot("account-b", 15, observedAt)];
    const concurrent = batch("account-a", observedAt, snapshots);
    concurrent.updates.unshift({
      canonicalLocalIdentity: "codex-account-b.json",
      weekly: snapshots[1].weekly,
      continuity: "continuous",
      observationId: snapshots[1].lastObservationId,
      observedAt,
      routeTraceId: "trace-concurrent-account-b",
    });
    concurrent.completedRoutes.unshift({
      canonicalLocalIdentity: "codex-account-b.json",
      observedAt,
      traceId: "trace-concurrent-account-b",
    });

    await coordinator.handleObservation(concurrent);
    const expectedIds = concurrent.updates.flatMap((update) => update.observationId ? [update.observationId] : []);
    const consumedIds = coordinator.publicState().audit.flatMap((event) => event.observationId ? [event.observationId] : []);
    expect(expectedIds.every((observationId) => consumedIds.filter((candidate) => candidate === observationId).length === 1)).toBe(true);

    await coordinator.handleObservation(concurrent);
    const replayedIds = coordinator.publicState().audit.flatMap((event) => event.observationId ? [event.observationId] : []);
    expect(expectedIds.every((observationId) => replayedIds.filter((candidate) => candidate === observationId).length === 1)).toBe(true);
    await coordinator.close();
  });

  it("persists same-watermark observation IDs beyond audit retention and fails closed on overflow", async () => {
    const root = await makeTempRoot();
    const writer = new NoWritePriorityWriter();
    const coordinator = await shadowHarness(root, writer);
    const observedAt = "2026-07-16T00:00:00.000Z";
    const snapshots = [snapshot("account-a", 20, observedAt), snapshot("account-b", 15, observedAt)];
    const capacity = MAX_EVIDENCE_WATERMARK_OBSERVATION_IDS;

    for (let index = 0; index < capacity; index += 1) {
      const observation = batch("account-a", observedAt, snapshots);
      observation.updates[0].observationId = `same-watermark-${index}`;
      await coordinator.handleObservation(observation);
    }
    const lastAuditIdBeforeReplay = coordinator.publicState().audit.at(-1)?.id;
    await coordinator.close();
    const restarted = await shadowHarness(root, writer);
    const replay = batch("account-a", observedAt, snapshots);
    replay.updates[0].observationId = "same-watermark-1";
    await restarted.handleObservation(replay);
    expect(restarted.publicState().audit.at(-1)?.id).toBe(lastAuditIdBeforeReplay);

    const overflow = batch("account-a", observedAt, snapshots);
    overflow.updates[0].observationId = `same-watermark-${capacity}`;
    await restarted.handleObservation(overflow);
    expect(restarted.publicState()).toMatchObject({
      lifecycle: "paused",
      pauseReason: "observation-uncertain",
      pauseMessage: "Evidence watermark observation ID capacity exceeded",
    });
    await restarted.close();
  });

  it("keeps deterministic coordinator replay fail-closed with zero priority-writer calls", async () => {
    const root = await makeTempRoot();
    const writer = new NoWritePriorityWriter();
    const coordinator = await shadowHarness(root, writer);
    const firstAt = "2026-07-16T00:00:00.000Z";
    const first = [snapshot("account-a", 20, firstAt), snapshot("account-b", 15, firstAt)];
    await coordinator.handleObservation(batch("account-a", firstAt, first));
    expect(coordinator.publicState().lastDecision).toMatchObject({ kind: "switch", targetKey: "account-b", spread: 5 });

    await coordinator.handleObservation(batch("account-a", firstAt, first));
    await coordinator.handleObservation(batch("account-b", "2026-07-15T23:59:59.000Z", first));

    const concurrentAt = "2026-07-16T00:00:02.000Z";
    const concurrent = batch("account-a", concurrentAt, [
      snapshot("account-a", 30, concurrentAt),
      snapshot("account-b", 10, concurrentAt),
    ]);
    concurrent.updates.unshift({
      canonicalLocalIdentity: "codex-account-b.json",
      weekly: concurrent.snapshotsByCanonicalIdentity.get("codex-account-b.json")?.weekly,
      continuity: "continuous",
      observationId: "observation-account-b-2026-07-16T00:00:01.000Z",
      observedAt: "2026-07-16T00:00:01.000Z",
      routeTraceId: "trace-concurrent-b",
    });
    concurrent.completedRoutes.unshift({
      canonicalLocalIdentity: "codex-account-b.json",
      observedAt: "2026-07-16T00:00:01.000Z",
      traceId: "trace-concurrent-b",
    });
    await coordinator.handleObservation(concurrent);

    const unsafeScenarios: Array<{
      name: string;
      unsafeSnapshot: (observedAt: string) => PersistedQuotaSnapshot;
    }> = [
      {
        name: "legacy-evidence",
        unsafeSnapshot: (observedAt) => snapshot("account-b", 0, observedAt, {
          weekly: { ...snapshot("account-b", 0, observedAt).weekly!, migrationOnly: true },
        }),
      },
      {
        name: "stale-evidence",
        unsafeSnapshot: (observedAt) => snapshot("account-b", 0, observedAt, {
          weekly: { ...snapshot("account-b", 0, observedAt).weekly!, resetAt: "2026-07-15T00:00:00.000Z" },
        }),
      },
      {
        name: "uncertain-evidence",
        unsafeSnapshot: (observedAt) => snapshot("account-b", 0, observedAt, {
          observationContinuity: "uncertain",
          weekly: { ...snapshot("account-b", 0, observedAt).weekly!, continuity: "uncertain" },
        }),
      },
      {
        name: "identity-mismatched-evidence",
        unsafeSnapshot: (observedAt) => snapshot("account-b", 0, observedAt, { identityMismatch: true }),
      },
      {
        name: "incompatible-schema-evidence",
        unsafeSnapshot: (observedAt) => snapshot("account-b", 0, observedAt, {
          weekly: { ...snapshot("account-b", 0, observedAt).weekly!, schemaVersion: 1 },
        }),
      },
    ];
    const executedScenarios = ["duplicate", "out-of-order", "concurrent-batch"];
    for (const [index, scenario] of unsafeScenarios.entries()) {
      const observedAt = new Date(Date.parse("2026-07-16T00:00:03.000Z") + index * 1_000).toISOString();
      await coordinator.handleObservation(batch("account-a", observedAt, [
        snapshot("account-a", 30, observedAt),
        scenario.unsafeSnapshot(observedAt),
      ]));
      expect(coordinator.publicState().lastDecision?.targetKey).not.toBe("account-b");
      executedScenarios.push(scenario.name);
    }

    const decisionEvents = coordinator.publicState().audit.filter((event) => event.kind === "decision");
    const decisionObservationIds = decisionEvents.map((event) => event.observationId).filter((value): value is string => Boolean(value));
    const switchEvents = decisionEvents.filter((event) => event.message.includes("Quota Spread reached"));
    const switchObservationIds = switchEvents.map((event) => event.observationId).filter((value): value is string => Boolean(value));
    const report = {
      switchDecisions: switchEvents.length,
      duplicateDecisions: decisionObservationIds.length - new Set(decisionObservationIds).size,
      duplicateSwitchDecisions: switchObservationIds.length - new Set(switchObservationIds).size,
      priorityWriterCalls: writer.setCalls + writer.restoreCalls,
      switchTargets: [...new Set(switchEvents.flatMap((event) => event.proxyAccountKey ? [event.proxyAccountKey] : []))],
      scenarios: executedScenarios,
    };

    expect(report).toEqual({
      switchDecisions: 2,
      duplicateDecisions: 0,
      duplicateSwitchDecisions: 0,
      priorityWriterCalls: 0,
      switchTargets: ["account-b"],
      scenarios: [
        "duplicate",
        "out-of-order",
        "concurrent-batch",
        "legacy-evidence",
        "stale-evidence",
        "uncertain-evidence",
        "identity-mismatched-evidence",
        "incompatible-schema-evidence",
      ],
    });
    await coordinator.close();
  });

  it("survives restart, pause, and Manual Hold replay without oscillation or writes", async () => {
    const root = await makeTempRoot();
    const writer = new NoWritePriorityWriter();
    const first = await shadowHarness(root, writer);
    const observedAt = "2026-07-16T00:00:00.000Z";
    const snapshots = [snapshot("account-a", 20, observedAt), snapshot("account-b", 15, observedAt)];
    await first.handleObservation(batch("account-a", observedAt, snapshots));
    await first.close();

    const restarted = await shadowHarness(root, writer);
    const decisionsBeforeReplay = restarted.publicState().audit.filter((event) => event.kind === "decision").length;
    await restarted.handleObservation(batch("account-a", observedAt, snapshots));
    expect(restarted.publicState().audit.filter((event) => event.kind === "decision")).toHaveLength(decisionsBeforeReplay);
    expect(restarted.publicState().lastDecision).toMatchObject({ kind: "switch", targetKey: "account-b" });

    await restarted.enterManualHold("Synthetic manual override");
    const manualAuditCount = restarted.publicState().audit.length;
    await restarted.handleObservation(batch("account-a", "2026-07-16T00:00:01.000Z", [
      snapshot("account-a", 40, "2026-07-16T00:00:01.000Z"),
      snapshot("account-b", 10, "2026-07-16T00:00:01.000Z"),
    ]));
    expect(restarted.publicState().audit).toHaveLength(manualAuditCount);

    await restarted.resume();
    await restarted.pause("Synthetic pause replay");
    const pausedAuditCount = restarted.publicState().audit.length;
    await restarted.handleObservation(batch("account-a", "2026-07-16T00:00:02.000Z", [
      snapshot("account-a", 50, "2026-07-16T00:00:02.000Z"),
      snapshot("account-b", 5, "2026-07-16T00:00:02.000Z"),
    ]));
    expect(restarted.publicState().audit).toHaveLength(pausedAuditCount);
    expect(writer.setCalls + writer.restoreCalls).toBe(0);
    await restarted.close();
  });

  it("excludes Provisional Reset Candidates from would-switch selection", () => {
    const active = policyAccount("account-active", 20);
    const provisional = policyAccount("account-provisional", 0, true);
    const safe = policyAccount("account-safe", 14);
    expect(decideRotation({
      accounts: [active, provisional, safe],
      routingTargetKey: active.proxyAccountKey,
      nowMs: Date.parse("2026-07-16T00:00:01.000Z"),
      recentAutomaticSwitches: [],
      observationId: "reset-replay-1",
      observationAt: "2026-07-16T00:00:01.000Z",
      mode: "shadow",
    })).toMatchObject({ kind: "switch", targetKey: "account-safe" });
  });
});
