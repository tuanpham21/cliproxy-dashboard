import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openRotationController } from "../rotation-controller.js";
import { RotationCoordinator, type RotationCoordinatorOptions } from "../rotation-coordinator.js";
import type { RotationObservationBatch } from "../rotation-log-observer.js";
import type { RotationPriorityWriter } from "../rotation-types.js";
import type { PersistedQuotaSnapshot } from "../types.js";
import { makeTempRoot, writeAccountFile } from "./helpers.js";

type ManagedProxyAccount = Awaited<ReturnType<RotationPriorityWriter["readAccounts"]>>[number];

class FakePriorityWriter implements RotationPriorityWriter {
  readonly accounts = new Map<string, ManagedProxyAccount>();
  readonly setCalls: Array<{ proxyAccountKey: string; priority: number }> = [];
  restoreCalls = 0;
  #revision = 20;

  constructor(accounts: ManagedProxyAccount[]) {
    for (const account of accounts) this.accounts.set(account.proxyAccountKey, structuredClone(account));
  }

  async readAccounts(): Promise<ManagedProxyAccount[]> {
    return [...this.accounts.values()].map((account) => structuredClone(account));
  }

  async setTargetPriority(input: Parameters<RotationPriorityWriter["setTargetPriority"]>[0]) {
    const account = this.accounts.get(input.proxyAccountKey);
    if (
      !account
      || account.fileName !== input.fileName
      || account.revision !== input.expectedRevision
      || account.fingerprint !== input.expectedFingerprint
    ) throw new Error("synthetic set conflict");
    account.priority = input.priority;
    account.explicitPriority = true;
    account.revision = `revision-${++this.#revision}`;
    this.setCalls.push({ proxyAccountKey: input.proxyAccountKey, priority: input.priority });
    return {
      priority: input.priority,
      explicitPriority: true as const,
      revision: account.revision,
      fingerprint: account.fingerprint,
    };
  }

  async restoreBasePriorities(entries: Parameters<RotationPriorityWriter["restoreBasePriorities"]>[0]): Promise<void> {
    for (const entry of Object.values(entries)) {
      const account = this.accounts.get(entry.proxyAccountKey);
      if (!account || account.fileName !== entry.fileName || account.revision !== entry.expectedRevision || account.fingerprint !== entry.expectedFingerprint) {
        throw new Error("synthetic restore conflict");
      }
      account.priority = entry.value ?? 0;
      account.explicitPriority = entry.present;
      account.revision = `revision-${++this.#revision}`;
      this.restoreCalls += 1;
    }
  }
}

function managedAccount(proxyAccountKey: string, fileName: string, priority: number): ManagedProxyAccount {
  return {
    proxyAccountKey,
    fileName,
    priority,
    explicitPriority: true,
    revision: `revision-${proxyAccountKey}`,
    fingerprint: `fingerprint-${proxyAccountKey}`,
    disabled: false,
    note: `note-${proxyAccountKey}`,
  };
}

function quotaSnapshot(proxyAccountKey: string, usedPercent: number, observedAt: string): PersistedQuotaSnapshot {
  const credentialFingerprint = `fingerprint-${proxyAccountKey}`;
  const lastObservationId = `observation-${proxyAccountKey}-${observedAt}`;
  return {
    proxyAccountKey,
    credentialFingerprint,
    observationContinuity: "continuous",
    lastObservationId,
    lastObservationAt: observedAt,
    weekly: {
      usedPercent,
      rawUsedPercent: usedPercent,
      resetAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      observedAt,
      source: "response-headers",
      durationMinutes: 10_080,
      windowKind: "weekly",
      evidenceId: `evidence-${proxyAccountKey}-${observedAt}`,
      credentialFingerprint,
      continuity: "continuous",
      schemaVersion: 2,
    },
  };
}

function observationBatch(
  observedKey: "account-a" | "account-b",
  observedAt: string,
  snapshots: PersistedQuotaSnapshot[],
  includeQuotaUpdate = true,
): RotationObservationBatch {
  const canonicalLocalIdentity = `codex-${observedKey}.json`;
  const traceId = `trace-${observedKey}-${observedAt}`;
  const observedSnapshot = snapshots.find((snapshot) => snapshot.proxyAccountKey === observedKey);
  return {
    updates: includeQuotaUpdate && observedSnapshot?.weekly
      ? [{
          canonicalLocalIdentity,
          weekly: observedSnapshot.weekly,
          continuity: "continuous",
          observationId: observedSnapshot.lastObservationId,
          observedAt,
          routeTraceId: traceId,
        }]
      : [],
    completedRoutes: [{
      canonicalLocalIdentity,
      observedAt,
      traceId,
    }],
    snapshotsByCanonicalIdentity: new Map(snapshots.map((snapshot) => [`codex-${snapshot.proxyAccountKey}.json`, snapshot])),
    errors: [],
    observedAt,
  };
}

async function activeCoordinator(
  options: RotationCoordinatorOptions = { canMutate: true },
  additionalAccounts: ManagedProxyAccount[] = [],
) {
  const root = await makeTempRoot();
  const authDir = path.join(root, "auth");
  const accounts = [
    managedAccount("account-a", "codex-account-a.json", 10),
    managedAccount("account-b", "codex-account-b.json", 5),
    ...additionalAccounts,
  ];
  await Promise.all(accounts.map((account) =>
    writeAccountFile(authDir, account.fileName, { priority: account.priority, validity_status: "valid" })));
  const writer = new FakePriorityWriter(accounts);
  const controller = await openRotationController({
    statePath: path.join(root, "rotation.json"),
    writer,
    mode: "active",
  });
  const coordinator = new RotationCoordinator(authDir, controller, options);
  for (const account of accounts) {
    await coordinator.upsertPoolMember({ proxyAccountKey: account.proxyAccountKey, fileName: account.fileName, exclusivityAttested: true });
  }
  return { authDir, controller, coordinator, writer };
}

describe("active rotation coordinator", () => {
  it("mutates on an active switch decision and confirms from the first newer routed event", async () => {
    const { controller, coordinator, writer } = await activeCoordinator();

    const firstAt = "2026-07-16T00:00:00.000Z";
    const snapshots = [quotaSnapshot("account-a", 80, firstAt), quotaSnapshot("account-b", 20, firstAt)];
    await coordinator.handleObservation(observationBatch("account-a", firstAt, snapshots));

    expect(writer.setCalls, JSON.stringify(coordinator.publicState())).toEqual([{ proxyAccountKey: "account-b", priority: 11 }]);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "awaiting-confirmation",
      observedRoutedAccountKey: "account-a",
      journal: { phase: "verified", routingTargetKey: "account-b", intendedPriority: 11 },
    });

    const confirmationAt = "2026-07-16T00:00:01.000Z";
    await coordinator.handleObservation(observationBatch("account-b", confirmationAt, [
      snapshots[0],
      quotaSnapshot("account-b", 20, confirmationAt),
    ]));

    expect(writer.setCalls).toHaveLength(1);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "active",
      routingTargetKey: "account-b",
      observedRoutedAccountKey: "account-b",
      journal: { phase: "idle" },
    });
    expect(controller.state().switchTimestamps).toHaveLength(1);
    expect(controller.state().lastSelectedAtByProxyAccountKey?.["account-b"]).toEqual(expect.any(Number));
    expect(coordinator.publicState().audit.map((event) => event.kind)).toContain("switch");
    await coordinator.close();
  });

  it("feeds persisted least-recent selection into equal-usage production decisions", async () => {
    const accountC = managedAccount("account-c", "codex-account-c.json", 1);
    const { coordinator, writer } = await activeCoordinator({ canMutate: true }, [accountC]);
    const firstAt = "2026-07-16T00:00:00.000Z";
    const firstSnapshots = [
      quotaSnapshot("account-a", 80, firstAt),
      quotaSnapshot("account-b", 20, firstAt),
      quotaSnapshot("account-c", 20, firstAt),
    ];
    await coordinator.handleObservation(observationBatch("account-a", firstAt, firstSnapshots));
    const confirmBAt = "2026-07-16T00:00:01.000Z";
    await coordinator.handleObservation(observationBatch("account-b", confirmBAt, [
      firstSnapshots[0],
      quotaSnapshot("account-b", 20, confirmBAt),
      firstSnapshots[2],
    ]));

    const switchAAt = "2026-07-16T00:00:02.000Z";
    const switchASnapshots = [
      quotaSnapshot("account-a", 20, switchAAt),
      quotaSnapshot("account-b", 80, switchAAt),
      quotaSnapshot("account-c", 20, switchAAt),
    ];
    await coordinator.handleObservation(observationBatch("account-b", switchAAt, switchASnapshots));
    const confirmAAt = "2026-07-16T00:00:03.000Z";
    await coordinator.handleObservation(observationBatch("account-a", confirmAAt, [
      quotaSnapshot("account-a", 20, confirmAAt),
      switchASnapshots[1],
      switchASnapshots[2],
    ]));

    const switchCAt = "2026-07-16T00:00:04.000Z";
    await coordinator.handleObservation(observationBatch("account-a", switchCAt, [
      quotaSnapshot("account-a", 80, switchCAt),
      quotaSnapshot("account-b", 20, switchCAt),
      quotaSnapshot("account-c", 20, switchCAt),
    ]));

    expect(writer.setCalls.map((call) => call.proxyAccountKey)).toEqual(["account-b", "account-a", "account-c"]);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "awaiting-confirmation",
      journal: { phase: "verified", routingTargetKey: "account-c" },
    });
    await coordinator.close();
  });

  it("allows one normal Provisional Reset Candidate request, confirms fresh evidence, and never retries a failed attempt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-07-14T00:00:00.000Z");
    const { coordinator, writer } = await activeCoordinator();
    try {
      const initialAt = "2026-07-14T00:00:00.000Z";
      const initialAccountA = quotaSnapshot("account-a", 80, initialAt);
      const initialAccountB = quotaSnapshot("account-b", 20, initialAt);
      initialAccountB.weekly!.resetAt = "2026-07-15T00:00:00.000Z";
      await coordinator.handleObservation(observationBatch("account-a", initialAt, [initialAccountA, initialAccountB]));
      const initialConfirmationAt = "2026-07-14T00:00:01.000Z";
      const retainedAccountB = quotaSnapshot("account-b", 20, initialConfirmationAt);
      retainedAccountB.weekly!.resetAt = "2026-07-15T00:00:00.000Z";
      await coordinator.handleObservation(observationBatch("account-b", initialConfirmationAt, [initialAccountA, retainedAccountB]));

      vi.setSystemTime("2026-07-16T00:00:00.000Z");
      const armAt = "2026-07-16T00:00:00.000Z";
      const armBatch = observationBatch("account-a", armAt, [quotaSnapshot("account-a", 20, armAt), retainedAccountB]);
      armBatch.completedRoutes = [];
      armBatch.updates[0].routeTraceId = undefined;
      await coordinator.handleObservation(armBatch);
      expect(coordinator.publicState()).toMatchObject({
        lifecycle: "active",
        provisionalCount: 1,
        lastDecision: { kind: "hold", reason: "Provisional Reset Candidate may receive one normal confirmation request" },
        provisionalResetAttempt: { proxyAccountKey: "account-b", resetAt: "2026-07-15T00:00:00.000Z", evidenceWatermark: armAt },
      });

      const freshConfirmationAt = "2026-07-16T00:00:01.000Z";
      const refreshedAccountB = quotaSnapshot("account-b", 5, freshConfirmationAt);
      refreshedAccountB.weekly!.resetAt = "2026-07-23T00:00:00.000Z";
      await coordinator.handleObservation(observationBatch("account-b", freshConfirmationAt, [
        quotaSnapshot("account-a", 20, freshConfirmationAt),
        refreshedAccountB,
      ]));
      expect(coordinator.publicState()).toMatchObject({
        lifecycle: "active",
        provisionalCount: 0,
        lastDecision: { kind: "hold", reason: "Quota Spread below five percentage points" },
      });
      expect(coordinator.publicState().provisionalResetAttempt).toBeUndefined();

      vi.setSystemTime("2026-07-24T00:00:00.000Z");
      const secondArmAt = "2026-07-24T00:00:00.000Z";
      const currentAccountA = quotaSnapshot("account-a", 20, secondArmAt);
      currentAccountA.weekly!.resetAt = "2026-07-30T00:00:00.000Z";
      const secondArmBatch = observationBatch("account-a", secondArmAt, [currentAccountA, refreshedAccountB]);
      secondArmBatch.completedRoutes = [];
      secondArmBatch.updates[0].routeTraceId = undefined;
      await coordinator.handleObservation(secondArmBatch);
      expect(coordinator.publicState().provisionalResetAttempt).toMatchObject({ proxyAccountKey: "account-b" });

      const missingEvidenceAt = "2026-07-24T00:00:01.000Z";
      await coordinator.handleObservation(observationBatch("account-b", missingEvidenceAt, [currentAccountA, refreshedAccountB], false));
      expect(coordinator.publicState()).toMatchObject({
        lifecycle: "paused",
        pauseReason: "observation-uncertain",
        pauseMessage: "Provisional Reset Candidate normal request lacked same-trace fresh weekly evidence",
      });
      const auditCountAfterFailure = coordinator.publicState().audit.length;
      await coordinator.handleObservation(observationBatch("account-b", "2026-07-24T00:00:02.000Z", [
        currentAccountA,
        quotaSnapshot("account-b", 0, "2026-07-24T00:00:02.000Z"),
      ]));
      expect(coordinator.publicState().audit).toHaveLength(auditCountAfterFailure);
      expect(writer.setCalls.map((call) => call.proxyAccountKey)).toEqual(["account-b"]);
    } finally {
      await coordinator.close();
      vi.useRealTimers();
    }
  });

  it("does not mutate and confirm from two historical observations delivered in one batch", async () => {
    const { coordinator, writer } = await activeCoordinator();
    const firstAt = "2026-07-16T00:00:00.000Z";
    const secondAt = "2026-07-16T00:00:01.000Z";
    const firstSnapshot = quotaSnapshot("account-a", 80, firstAt);
    const secondSnapshot = quotaSnapshot("account-b", 20, secondAt);
    const delivered = observationBatch("account-b", secondAt, [firstSnapshot, secondSnapshot]);
    delivered.updates.unshift({
      canonicalLocalIdentity: "codex-account-a.json",
      weekly: firstSnapshot.weekly,
      continuity: "continuous",
      observationId: firstSnapshot.lastObservationId,
      observedAt: firstAt,
      routeTraceId: "trace-same-delivery-account-a",
    });
    delivered.completedRoutes.unshift({
      canonicalLocalIdentity: "codex-account-a.json",
      observedAt: firstAt,
      traceId: "trace-same-delivery-account-a",
    });

    await coordinator.handleObservation(delivered);

    expect(writer.setCalls).toEqual([]);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "active",
      observedRoutedAccountKey: "account-b",
      journal: { phase: "idle" },
    });
    const consumedIds = coordinator.publicState().audit.flatMap((event) => event.observationId ? [event.observationId] : []);
    expect(consumedIds.filter((candidate) => candidate === firstSnapshot.lastObservationId)).toHaveLength(1);
    expect(consumedIds.filter((candidate) => candidate === secondSnapshot.lastObservationId)).toHaveLength(1);
    await coordinator.close();
  });

  it("cannot confirm an active mutation from historical traffic in the same observer batch", async () => {
    const { controller, coordinator, writer } = await activeCoordinator();
    const historicalAt = "2026-07-16T00:00:00.000Z";
    const decisionAt = "2026-07-16T00:00:01.000Z";
    const accountAQuotaSnapshot = quotaSnapshot("account-a", 80, decisionAt);
    const historicalAccountBQuotaSnapshot = quotaSnapshot("account-b", 20, historicalAt);
    const batch = observationBatch("account-a", decisionAt, [accountAQuotaSnapshot, historicalAccountBQuotaSnapshot]);
    batch.completedRoutes.unshift({
      canonicalLocalIdentity: "codex-account-b.json",
      observedAt: historicalAt,
      traceId: "trace-historical-account-b",
    });
    batch.updates.unshift({
      canonicalLocalIdentity: "codex-account-b.json",
      weekly: historicalAccountBQuotaSnapshot.weekly,
      continuity: "continuous",
      observationId: historicalAccountBQuotaSnapshot.lastObservationId,
      observedAt: historicalAt,
      routeTraceId: "trace-historical-account-b",
    });

    await coordinator.handleObservation(batch);

    expect(writer.setCalls).toEqual([{ proxyAccountKey: "account-b", priority: 11 }]);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "awaiting-confirmation",
      observedRoutedAccountKey: "account-a",
      journal: { phase: "verified", routingTargetKey: "account-b" },
    });
    expect(controller.state().switchTimestamps).toEqual([]);

    const confirmationAt = "2026-07-16T00:00:02.000Z";
    await coordinator.handleObservation(observationBatch("account-b", confirmationAt, [
      accountAQuotaSnapshot,
      quotaSnapshot("account-b", 20, confirmationAt),
    ]));

    expect(writer.setCalls).toHaveLength(1);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "active",
      routingTargetKey: "account-b",
      observedRoutedAccountKey: "account-b",
      journal: { phase: "idle" },
    });
    expect(controller.state().switchTimestamps).toHaveLength(1);
    await coordinator.close();
  });

  it("consumes recognized weekly observations before pausing on a mixed observer-error batch", async () => {
    const { controller, coordinator, writer } = await activeCoordinator();
    const firstAt = "2026-07-16T00:00:00.000Z";
    const secondAt = "2026-07-16T00:00:01.000Z";
    const firstQuotaSnapshot = quotaSnapshot("account-a", 80, firstAt);
    const secondQuotaSnapshot = quotaSnapshot("account-b", 20, secondAt);
    const batch = observationBatch("account-b", secondAt, [firstQuotaSnapshot, secondQuotaSnapshot]);
    batch.updates.unshift({
      canonicalLocalIdentity: "codex-account-a.json",
      weekly: firstQuotaSnapshot.weekly,
      continuity: "continuous",
      observationId: firstQuotaSnapshot.lastObservationId,
      observedAt: firstAt,
      routeTraceId: "trace-mixed-error-account-a",
    });
    batch.completedRoutes.unshift({
      canonicalLocalIdentity: "codex-account-a.json",
      observedAt: firstAt,
      traceId: "trace-mixed-error-account-a",
    });
    batch.errors.push("synthetic tracked-file overflow");

    await coordinator.handleObservation(batch);

    expect(writer.setCalls).toEqual([]);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "paused",
      pauseReason: "observation-uncertain",
      pauseMessage: "synthetic tracked-file overflow",
      journal: { phase: "idle" },
    });
    const consumedIds = controller.state().audit.flatMap((event) => event.observationId ? [event.observationId] : []);
    expect(consumedIds.filter((candidate) => candidate === firstQuotaSnapshot.lastObservationId)).toHaveLength(1);
    expect(consumedIds.filter((candidate) => candidate === secondQuotaSnapshot.lastObservationId)).toHaveLength(1);
    await coordinator.close();
  });

  it("fails closed on the first newer routed event even when a later event matches", async () => {
    const { coordinator, writer } = await activeCoordinator();
    const firstAt = "2026-07-16T00:00:00.000Z";
    const snapshots = [quotaSnapshot("account-a", 80, firstAt), quotaSnapshot("account-b", 20, firstAt)];
    await coordinator.handleObservation(observationBatch("account-a", firstAt, snapshots));

    const accountAConfirmation = quotaSnapshot("account-a", 80, "2026-07-16T00:00:01.000Z");
    const confirmation = observationBatch("account-b", "2026-07-16T00:00:02.000Z", [
      accountAConfirmation,
      quotaSnapshot("account-b", 20, "2026-07-16T00:00:02.000Z"),
    ]);
    confirmation.completedRoutes.unshift({
      canonicalLocalIdentity: "codex-account-a.json",
      observedAt: "2026-07-16T00:00:01.000Z",
      traceId: "trace-first-wrong-route",
    });
    confirmation.updates.unshift({
      canonicalLocalIdentity: "codex-account-a.json",
      weekly: accountAConfirmation.weekly,
      continuity: "continuous",
      observationId: accountAConfirmation.lastObservationId,
      observedAt: accountAConfirmation.lastObservationAt,
      routeTraceId: "trace-first-wrong-route",
    });
    await coordinator.handleObservation(confirmation);

    expect(writer.setCalls).toHaveLength(1);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "paused",
      pauseReason: "selection-mismatch",
      observedRoutedAccountKey: "account-a",
      journal: { phase: "verified", routingTargetKey: "account-b" },
    });
    await coordinator.close();
  });

  it("does not confirm from a routed event without same-trace fresh weekly evidence", async () => {
    const { coordinator, writer } = await activeCoordinator();
    const firstAt = "2026-07-16T00:00:00.000Z";
    const snapshots = [quotaSnapshot("account-a", 80, firstAt), quotaSnapshot("account-b", 20, firstAt)];
    await coordinator.handleObservation(observationBatch("account-a", firstAt, snapshots));

    await coordinator.handleObservation(observationBatch("account-b", "2026-07-16T00:00:01.000Z", snapshots, false));

    expect(writer.setCalls).toHaveLength(1);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "paused",
      pauseReason: "observation-uncertain",
      journal: { phase: "verified", routingTargetKey: "account-b" },
    });
    await coordinator.close();
  });

  it("does not decide or mutate while Manual Hold is active", async () => {
    const { coordinator, writer } = await activeCoordinator();
    await coordinator.enterManualHold("Synthetic operator action");
    const observedAt = "2026-07-16T00:00:00.000Z";
    await coordinator.handleObservation(observationBatch("account-a", observedAt, [
      quotaSnapshot("account-a", 80, observedAt),
      quotaSnapshot("account-b", 20, observedAt),
    ]));

    expect(writer.setCalls).toEqual([]);
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "manual-hold", manualHold: true });
    await coordinator.close();
  });

  it("does not mutate when Manual Hold interleaves after observation state is read", async () => {
    let releaseReadiness!: () => void;
    let readinessStarted!: () => void;
    const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    const started = new Promise<void>((resolve) => { readinessStarted = resolve; });
    const { coordinator, writer } = await activeCoordinator({
      canMutate: true,
      readinessCheck: async () => {
        readinessStarted();
        await readinessGate;
        return { compatible: true };
      },
    });
    const observedAt = "2026-07-16T00:00:00.000Z";
    const handling = coordinator.handleObservation(observationBatch("account-a", observedAt, [
      quotaSnapshot("account-a", 80, observedAt),
      quotaSnapshot("account-b", 20, observedAt),
    ]));
    await started;
    await coordinator.enterManualHold("Synthetic operator interleave");
    releaseReadiness();
    await handling;

    expect(writer.setCalls).toEqual([]);
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "manual-hold", manualHold: true, journal: { phase: "idle" } });
    await coordinator.close();
  });

  it("does not mutate when all pool members are removed after observation state is read", async () => {
    let releaseReadiness!: () => void;
    let readinessStarted!: () => void;
    const readinessGate = new Promise<void>((resolve) => { releaseReadiness = resolve; });
    const started = new Promise<void>((resolve) => { readinessStarted = resolve; });
    const { coordinator, writer } = await activeCoordinator({
      canMutate: true,
      readinessCheck: async () => {
        readinessStarted();
        await readinessGate;
        return { compatible: true };
      },
    });
    const observedAt = "2026-07-16T00:00:00.000Z";
    const handling = coordinator.handleObservation(observationBatch("account-a", observedAt, [
      quotaSnapshot("account-a", 80, observedAt),
      quotaSnapshot("account-b", 20, observedAt),
    ]));
    await started;
    await Promise.all([
      coordinator.removePoolMember("account-a"),
      coordinator.removePoolMember("account-b"),
    ]);
    releaseReadiness();
    await handling;

    expect(writer.setCalls).toEqual([]);
    expect(coordinator.publicState()).toMatchObject({ pool: [], journal: { phase: "idle" } });
    await coordinator.close();
  });

  it("pauses before mutation when routing prerequisites become incompatible", async () => {
    const { coordinator, writer } = await activeCoordinator({
      canMutate: true,
      readinessCheck: async () => ({ compatible: false, reason: "fill-first routing required" }),
    });
    const observedAt = "2026-07-16T00:00:00.000Z";
    await coordinator.handleObservation(observationBatch("account-a", observedAt, [
      quotaSnapshot("account-a", 80, observedAt),
      quotaSnapshot("account-b", 20, observedAt),
    ]));

    expect(writer.setCalls).toEqual([]);
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "paused", pauseReason: "routing-incompatible", routingCompatible: false });
    await coordinator.close();
  });

  it("does not commit a Pending Rotation when routing becomes incompatible before confirmation", async () => {
    let checks = 0;
    const { coordinator, writer } = await activeCoordinator({
      canMutate: true,
      readinessCheck: async () => ++checks === 1
        ? { compatible: true }
        : { compatible: false, reason: "routing changed during Pending Rotation" },
    });
    const firstAt = "2026-07-16T00:00:00.000Z";
    await coordinator.handleObservation(observationBatch("account-a", firstAt, [
      quotaSnapshot("account-a", 80, firstAt),
      quotaSnapshot("account-b", 20, firstAt),
    ]));
    const confirmationAt = "2026-07-16T00:00:01.000Z";
    await coordinator.handleObservation(observationBatch("account-b", confirmationAt, [
      quotaSnapshot("account-a", 80, firstAt),
      quotaSnapshot("account-b", 20, confirmationAt),
    ]));

    expect(writer.setCalls).toHaveLength(1);
    expect(coordinator.publicState()).toMatchObject({
      lifecycle: "paused",
      pauseReason: "routing-incompatible",
      journal: { phase: "verified", routingTargetKey: "account-b" },
      routingCompatible: false,
    });
    await coordinator.close();
  });

  it("rolls back a Pending Rotation before removing a pool member", async () => {
    const { coordinator, writer } = await activeCoordinator();
    const observedAt = "2026-07-16T00:00:00.000Z";
    await coordinator.handleObservation(observationBatch("account-a", observedAt, [
      quotaSnapshot("account-a", 80, observedAt),
      quotaSnapshot("account-b", 20, observedAt),
    ]));
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "awaiting-confirmation", journal: { phase: "verified" } });

    await coordinator.removePoolMember("account-b");

    expect(writer.restoreCalls).toBe(1);
    expect(writer.accounts.get("account-b")).toMatchObject({ priority: 5, explicitPriority: true });
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "active", journal: { phase: "idle" }, restorationVerified: true });
    expect(coordinator.publicState().pool.map((member) => member.proxyAccountKey)).toEqual(["account-a"]);
    await coordinator.close();
  });

  it("pauses instead of deciding from a partial second account read", async () => {
    const { authDir, coordinator, writer } = await activeCoordinator();
    await writeFile(path.join(authDir, "codex-broken.json"), "{not-json", "utf8");
    const observedAt = "2026-07-16T00:00:00.000Z";
    await coordinator.handleObservation(observationBatch("account-a", observedAt, [
      quotaSnapshot("account-a", 80, observedAt),
      quotaSnapshot("account-b", 20, observedAt),
    ]));

    expect(writer.setCalls).toEqual([]);
    expect(coordinator.publicState()).toMatchObject({ lifecycle: "paused", pauseReason: "observation-uncertain" });
    await coordinator.close();
  });
});
