import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  CLI_PROXY_PRIORITY_CONTRACT_COMMIT,
  CLI_PROXY_PRIORITY_CONTRACT_VERSION,
  createCliProxyManagementWriter,
} from "../cli-proxy-management.js";
import { createRotationCoordinator } from "../rotation-coordinator.js";
import { openRotationController } from "../rotation-controller.js";
import { readJsonObject } from "../files.js";
import type { RotationObservationBatch } from "../rotation-log-observer.js";
import { deriveCredentialFingerprint } from "../rotation-policy.js";
import { createEmptyQuotaSnapshotStore, deriveProxyAccountKey } from "../quota-store.js";
import type { RotationPriorityWriter } from "../rotation-types.js";
import type { PersistedQuotaSnapshot } from "../types.js";
import { normalizeProxyAccountLocalIdentity } from "../util.js";
import { makeTempRoot, writeAccountFile, writeConfig } from "./helpers.js";

const runtimeHeaders = {
  "X-CPA-VERSION": CLI_PROXY_PRIORITY_CONTRACT_VERSION,
  "X-CPA-COMMIT": CLI_PROXY_PRIORITY_CONTRACT_COMMIT,
  "X-CPA-BUILD-DATE": "2026-07-14T15:37:22Z",
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...runtimeHeaders },
  });
}

function quotaSnapshot(
  proxyAccountKey: string,
  credentialFingerprint: string,
  usedPercent: number,
  observedAt: string,
): PersistedQuotaSnapshot {
  const lastObservationId = `observation-${proxyAccountKey}`;
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
      evidenceId: `evidence-${proxyAccountKey}`,
      credentialFingerprint,
      continuity: "continuous",
      schemaVersion: 2,
    },
  };
}

function observationBatch(
  observedFileName: string,
  observedAt: string,
  snapshotsByFileName: Map<string, PersistedQuotaSnapshot>,
): RotationObservationBatch {
  const observedSnapshot = snapshotsByFileName.get(observedFileName);
  if (!observedSnapshot?.weekly || !observedSnapshot.lastObservationId) {
    throw new Error("synthetic observed quota snapshot unavailable");
  }
  return {
    updates: [{
      canonicalLocalIdentity: normalizeProxyAccountLocalIdentity(observedFileName),
      weekly: observedSnapshot.weekly,
      continuity: "continuous",
      observationId: observedSnapshot.lastObservationId,
      observedAt,
      routeTraceId: "trace-management-only",
    }],
    completedRoutes: [{
      canonicalLocalIdentity: normalizeProxyAccountLocalIdentity(observedFileName),
      observedAt,
      traceId: "trace-management-only",
    }],
    snapshotsByCanonicalIdentity: new Map([...snapshotsByFileName].map(([fileName, snapshot]) => [
      normalizeProxyAccountLocalIdentity(fileName),
      snapshot,
    ])),
    errors: [],
    observedAt,
  };
}

describe("management-only rotation safety", () => {
  it("snapshots disk-backed and management-only entries with revision-bound identities", async () => {
    let managementOnlyRevision = "runtime-revision-1";
    const writer = createCliProxyManagementWriter({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
      fingerprintResolver: (fileName) => fileName === "codex-disk.json"
        ? "credential-fingerprint-disk"
        : undefined,
      managementOnlyFingerprintResolver: (_fileName, revision) => `opaque-management-fingerprint:${revision}`,
      proxyAccountKeyResolver: (fileName) => `pak:${fileName}`,
      fetchImpl: async () => response({
        files: [
          {
            name: "codex-disk.json",
            priority: 12,
            priority_present: true,
            revision: "disk-revision-1",
            disabled: false,
            note: "disk-backed",
          },
          {
            name: "runtime-only.json",
            priority: 40,
            priority_present: true,
            revision: managementOnlyRevision,
            disabled: true,
            note: "runtime-only",
          },
        ],
      }),
    });

    const first = await writer.readAccounts();
    expect(first).toEqual([
      {
        proxyAccountKey: "pak:codex-disk.json",
        fileName: "codex-disk.json",
        priority: 12,
        explicitPriority: true,
        revision: "disk-revision-1",
        fingerprint: "credential-fingerprint-disk",
        disabled: false,
        note: "disk-backed",
      },
      {
        proxyAccountKey: "pak:runtime-only.json",
        fileName: "runtime-only.json",
        priority: 40,
        explicitPriority: true,
        revision: "runtime-revision-1",
        fingerprint: "opaque-management-fingerprint:runtime-revision-1",
        disabled: true,
        note: "runtime-only",
      },
    ]);

    managementOnlyRevision = "runtime-revision-2";
    const second = await writer.readAccounts();
    expect(second[0]?.fingerprint).toBe("credential-fingerprint-disk");
    expect(second[1]?.fingerprint).toBe("opaque-management-fingerprint:runtime-revision-2");
    expect(second[1]?.fingerprint).not.toBe(first[1]?.fingerprint);
  });

  it("includes a higher-priority management-only entry while mutating the disk-backed target", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const configPath = await writeConfig(root, authDir);
    const quotaSnapshotStatePath = path.join(authDir, "cliproxy-dashboard", "quota-snapshots.json");
    const sourceFileName = "codex-source.json";
    const targetFileName = "codex-target.json";
    const managementOnlyFileName = "runtime-only.json";
    await writeAccountFile(authDir, sourceFileName, { account_id: "acct-source", validity_status: "valid" });
    await writeAccountFile(authDir, targetFileName, { account_id: "acct-target", validity_status: "valid" });

    const store = createEmptyQuotaSnapshotStore();
    await mkdir(path.dirname(quotaSnapshotStatePath), { recursive: true });
    await writeFile(quotaSnapshotStatePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    const sourceRaw = await readJsonObject(path.join(authDir, sourceFileName));
    const targetRaw = await readJsonObject(path.join(authDir, targetFileName));
    if (!sourceRaw || !targetRaw) throw new Error("synthetic credential fixture unavailable");

    const sourceKey = deriveProxyAccountKey(store, normalizeProxyAccountLocalIdentity(sourceFileName));
    const targetKey = deriveProxyAccountKey(store, normalizeProxyAccountLocalIdentity(targetFileName));
    const managementOnlyKey = deriveProxyAccountKey(store, normalizeProxyAccountLocalIdentity(managementOnlyFileName));
    const sourceFingerprint = deriveCredentialFingerprint(store.keyDerivation.secret, sourceFileName, sourceRaw);
    const targetFingerprint = deriveCredentialFingerprint(store.keyDerivation.secret, targetFileName, targetRaw);
    const managementEntries = [
      { name: sourceFileName, priority: 10, priority_present: true, revision: "source-revision-1", disabled: false, note: "source" },
      { name: targetFileName, priority: 5, priority_present: true, revision: "target-revision-1", disabled: false, note: "target" },
      { name: managementOnlyFileName, priority: 40, priority_present: true, revision: "runtime-revision-1", disabled: true, note: "runtime-only" },
    ];
    const patchBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchBodies.push(body);
        const targetEntry = managementEntries.find((entry) => entry.name === body.name);
        if (!targetEntry) throw new Error("synthetic target entry unavailable");
        targetEntry.priority = Number(body.priority);
        targetEntry.priority_present = body.operation === "set";
        targetEntry.revision = "target-revision-2";
        return response({
          status: "ok",
          id: targetEntry.name,
          name: targetEntry.name,
          revision: targetEntry.revision,
          priority: { present: true, value: targetEntry.priority },
          persisted: true,
        });
      }
      return response({ files: managementEntries });
    });

    const coordinator = await createRotationCoordinator({
      configPath,
      authDir,
      quotaSnapshotStatePath,
      proxyUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
    });
      try {
        await coordinator.upsertPoolMember({ proxyAccountKey: sourceKey, fileName: sourceFileName, exclusivityAttested: true });
        await coordinator.upsertPoolMember({ proxyAccountKey: targetKey, fileName: targetFileName, exclusivityAttested: true });
        await coordinator.upsertPoolMember({ proxyAccountKey: managementOnlyKey, fileName: managementOnlyFileName, exclusivityAttested: true });
        await coordinator.setMode("active");
      const observedAt = "2026-07-16T00:00:00.000Z";
      await coordinator.handleObservation(observationBatch(sourceFileName, observedAt, new Map([
        [sourceFileName, quotaSnapshot(sourceKey, sourceFingerprint, 80, observedAt)],
        [targetFileName, quotaSnapshot(targetKey, targetFingerprint, 20, observedAt)],
      ])));

      expect(patchBodies).toEqual([{
        name: targetFileName,
        expected_revision: "target-revision-1",
        operation: "set",
        priority: 41,
      }]);
      expect(coordinator.state()).toMatchObject({
        lifecycle: "awaiting-confirmation",
        journal: {
          phase: "verified",
          routingTargetKey: targetKey,
          intendedPriority: 41,
          targetFingerprint,
          basePriorities: {
            [targetKey]: { fingerprint: targetFingerprint, present: true, value: 5 },
            [managementOnlyKey]: {
              fileName: managementOnlyFileName,
              present: true,
              value: 40,
              fingerprint: expect.stringMatching(/^mef_v1_[A-Za-z0-9_-]+$/),
              disabled: true,
              note: "runtime-only",
            },
          },
        },
      });
    } finally {
      await coordinator.close();
      vi.unstubAllGlobals();
    }
  });

  it("pauses fail-closed when the initial management snapshot cannot be read", async () => {
    const root = await makeTempRoot();
    let patchCalls = 0;
    const writer: RotationPriorityWriter = {
      readAccounts: async () => {
        throw new Error("synthetic management snapshot failed");
      },
      setTargetPriority: async () => {
        patchCalls += 1;
        throw new Error("unexpected priority patch");
      },
      restoreBasePriorities: async () => undefined,
    };
    const controller = await openRotationController({
      statePath: path.join(root, "rotation.json"),
      writer,
      mode: "active",
      now: () => Date.parse("2026-07-16T00:00:00.000Z"),
    });

    try {
      await controller.updatePool(() => [{
        proxyAccountKey: "pak_target",
        fileName: "codex-target.json",
        exclusivityAttested: true,
        addedAt: "2026-07-16T00:00:00.000Z",
      }]);
      const state = await controller.beginPendingRotation({
        observationId: "observation-1",
        evidenceWatermark: "2026-07-16T00:00:00.000Z",
        fromProxyAccountKey: "pak_source",
        routingTargetKey: "pak_target",
        targetFingerprint: "fingerprint-target",
      });

      expect(state).toMatchObject({
        lifecycle: "paused",
        pauseReason: "mutation-failed",
        journal: { phase: "idle" },
      });
      expect(state.pauseMessage).toMatch(/management snapshot failed/i);
      expect(state.audit.at(-1)).toMatchObject({
        kind: "pause",
        pauseReason: "mutation-failed",
      });
      expect(state.audit.at(-1)?.message).toMatch(/management snapshot failed/i);
      expect(patchCalls).toBe(0);
    } finally {
      await controller.close();
    }
  });
});
