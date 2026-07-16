import path from "node:path";

import { readAccounts } from "./accounts.js";
import { openRotationController, type RotationController } from "./rotation-controller.js";
import type { RotationObservationBatch } from "./rotation-log-observer.js";
import { resolveDashboardPaths } from "./paths.js";
import { decideRotation } from "./rotation-policy.js";
import type { RotationAccountSnapshot, RotationDecision, SemanticQuotaEvidence } from "./rotation-types.js";
import type { AccountView, DashboardOptions, PersistedQuotaSnapshot, PersistedQuotaWindowEvidence } from "./types.js";
import { normalizeProxyAccountLocalIdentity } from "./util.js";

function semanticWeekly(
  evidence: PersistedQuotaWindowEvidence | undefined,
  snapshot: PersistedQuotaSnapshot | undefined,
): SemanticQuotaEvidence | undefined {
  if (
    typeof evidence?.usedPercent !== "number"
    || !evidence.evidenceId
    || !evidence.credentialFingerprint
    || evidence.windowKind !== "weekly"
    || !evidence.continuity
    || typeof evidence.schemaVersion !== "number"
  ) return undefined;
  return {
    usedPercent: evidence.usedPercent,
    ...(typeof evidence.rawUsedPercent === "number" ? { rawUsedPercent: evidence.rawUsedPercent } : {}),
    ...(evidence.resetAt ? { resetAt: evidence.resetAt } : {}),
    observedAt: evidence.observedAt,
    ...(evidence.durationMinutes === undefined ? {} : { durationMinutes: evidence.durationMinutes }),
    windowKind: "weekly",
    ...(evidence.providerSlot ? { providerSlot: evidence.providerSlot } : {}),
    evidenceId: evidence.evidenceId,
    credentialFingerprint: evidence.credentialFingerprint,
    continuity: snapshot?.observationContinuity ?? evidence.continuity,
    ...(evidence.migrationOnly === undefined ? {} : { migrationOnly: evidence.migrationOnly }),
    schemaVersion: evidence.schemaVersion,
  };
}

function rotationProxyAccount(
  proxyAccount: AccountView,
  snapshot: PersistedQuotaSnapshot | undefined,
  pool: Map<string, { exclusivityAttested: boolean }>,
): RotationAccountSnapshot | null {
  if (!snapshot) return null;
  const membership = pool.get(snapshot.proxyAccountKey);
  const weekly = semanticWeekly(snapshot.weekly, snapshot);
  return {
    proxyAccountKey: snapshot.proxyAccountKey,
    fileName: proxyAccount.fileName,
    enabled: !proxyAccount.disabled,
    sessionValid: proxyAccount.validityStatus === "valid",
    observable: snapshot.observationContinuity === "continuous",
    observationContinuity: snapshot.observationContinuity ?? "uncertain",
    rotationPoolMember: Boolean(membership),
    exclusivityAttested: membership?.exclusivityAttested ?? false,
    identityFingerprint: snapshot.credentialFingerprint ?? "",
    identityVerified: Boolean(snapshot.credentialFingerprint && !snapshot.identityMismatch),
    ...(weekly ? { weekly } : {}),
    exhausted: Boolean(weekly && weekly.usedPercent >= 100),
    priority: proxyAccount.priority,
    explicitPriority: proxyAccount.explicitPriority,
  };
}

function latestObservation(batch: RotationObservationBatch): { observationId: string; observationAt: string } | null {
  const candidates = [
    ...batch.updates.flatMap((update) => update.observationId && update.observedAt ? [{ observationId: update.observationId, observationAt: update.observedAt }] : []),
    ...batch.completedRoutes.map((route) => ({ observationId: `route_${route.traceId}`, observationAt: route.observedAt })),
  ];
  return candidates.sort((left, right) => Date.parse(right.observationAt) - Date.parse(left.observationAt))[0] ?? null;
}

export class RotationCoordinator {
  readonly #dashboardOptions: DashboardOptions;
  readonly #controller: RotationController;

  constructor(dashboardOptions: DashboardOptions, controller: RotationController) {
    this.#dashboardOptions = dashboardOptions;
    this.#controller = controller;
  }

  state() {
    return this.#controller.state();
  }

  async handleObservation(batch: RotationObservationBatch): Promise<void> {
    const observation = latestObservation(batch);
    if (!observation && batch.errors.length === 0) return;
    const controllerState = this.#controller.state();
    let decision: RotationDecision;
    if (batch.errors.length > 0) {
      decision = { kind: "pause", reason: batch.errors.join("; "), pauseReason: "observation-uncertain" };
    } else {
      const proxyAccountsResult = await readAccounts((await resolveDashboardPaths(this.#dashboardOptions)).authDir);
      const pool = new Map(controllerState.pool.map((member) => [member.proxyAccountKey, member]));
      const proxyAccounts = proxyAccountsResult.accounts.flatMap((proxyAccount) => {
        const snapshot = batch.snapshotsByCanonicalIdentity.get(normalizeProxyAccountLocalIdentity(proxyAccount.fileName));
        const rotationSnapshot = rotationProxyAccount(proxyAccount, snapshot, pool);
        return rotationSnapshot ? [rotationSnapshot] : [];
      });
      decision = decideRotation({
        accounts: proxyAccounts,
        routingTargetKey: controllerState.routingTargetKey,
        nowMs: Date.now(),
        recentAutomaticSwitches: controllerState.switchTimestamps,
        observationId: observation!.observationId,
        observationAt: observation!.observationAt,
        mode: controllerState.mode,
        seenObservationIds: controllerState.lastObservationId ? [controllerState.lastObservationId] : [],
        evidenceWatermark: controllerState.evidenceWatermark,
      });
    }
    await this.#controller.recordObservationDecision({
      decision,
      observationId: observation?.observationId ?? `observer_error_${Date.now()}`,
      observationAt: observation?.observationAt ?? batch.observedAt,
    });
  }

  async close(): Promise<void> {
    await this.#controller.close();
  }
}

export async function createRotationCoordinator(options: DashboardOptions): Promise<RotationCoordinator> {
  const paths = await resolveDashboardPaths(options);
  const statePath = path.join(path.dirname(paths.quotaSnapshotStatePath), "rotation-controller.json");
  const controller = await openRotationController({ statePath });
  return new RotationCoordinator(options, controller);
}
