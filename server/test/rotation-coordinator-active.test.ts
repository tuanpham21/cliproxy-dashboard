import { writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

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
      resetAt: "2026-07-20T00:00:00.000Z",
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

async function activeCoordinator(options: RotationCoordinatorOptions = { canMutate: true }) {
  const root = await makeTempRoot();
  const authDir = path.join(root, "auth");
  await writeAccountFile(authDir, "codex-account-a.json", { priority: 10, validity_status: "valid" });
  await writeAccountFile(authDir, "codex-account-b.json", { priority: 5, validity_status: "valid" });
  const writer = new FakePriorityWriter([
    managedAccount("account-a", "codex-account-a.json", 10),
    managedAccount("account-b", "codex-account-b.json", 5),
  ]);
  const controller = await openRotationController({
    statePath: path.join(root, "rotation.json"),
    writer,
    mode: "active",
  });
  const coordinator = new RotationCoordinator(authDir, controller, options);
  await coordinator.upsertPoolMember({ proxyAccountKey: "account-a", fileName: "codex-account-a.json", exclusivityAttested: true });
  await coordinator.upsertPoolMember({ proxyAccountKey: "account-b", fileName: "codex-account-b.json", exclusivityAttested: true });
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
    expect(coordinator.publicState().audit.map((event) => event.kind)).toContain("switch");
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
