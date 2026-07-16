import path from "node:path";

import type { PublicRotationState } from "../shared/types.js";
import { readAccounts } from "./accounts.js";
import { createCliProxyManagementWriter } from "./cli-proxy-management.js";
import { readConfig } from "./config.js";
import { readJsonObject } from "./files.js";
import { openRotationController, type RotationController } from "./rotation-controller.js";
import type { RotationObservationBatch } from "./rotation-log-observer.js";
import { resolveDashboardPaths } from "./paths.js";
import { resolveAccountPath } from "./paths.js";
import { deriveCredentialFingerprint, decideRotation, isRotationEligible } from "./rotation-policy.js";
import { deriveProxyAccountKey, readQuotaSnapshotStoreFile } from "./quota-store.js";
import type { RotationAccountSnapshot, RotationDecision, RotationMode, RotationState, SemanticQuotaEvidence } from "./rotation-types.js";
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

function newestCompletedRoute(batch: RotationObservationBatch): RotationObservationBatch["completedRoutes"][number] | undefined {
  return [...batch.completedRoutes].sort((left, right) => {
    const byTime = Date.parse(right.observedAt) - Date.parse(left.observedAt);
    return byTime || right.traceId.localeCompare(left.traceId);
  })[0];
}

function firstCompletedRouteAfter(
  batch: RotationObservationBatch,
  watermark: string | undefined,
): RotationObservationBatch["completedRoutes"][number] | undefined {
  const watermarkMs = Date.parse(watermark ?? "");
  if (!Number.isFinite(watermarkMs)) return undefined;
  return [...batch.completedRoutes]
    .filter((route) => Date.parse(route.observedAt) > watermarkMs)
    .sort((left, right) => {
      const byTime = Date.parse(left.observedAt) - Date.parse(right.observedAt);
      return byTime || left.traceId.localeCompare(right.traceId);
  })[0];
}

function confirmationEvidence(
  batch: RotationObservationBatch,
  route: RotationObservationBatch["completedRoutes"][number],
): { proxyAccountKey: string; fingerprint: string; observedAt: string } | undefined {
  const update = batch.updates.find((candidate) =>
    candidate.canonicalLocalIdentity === route.canonicalLocalIdentity
    && candidate.routeTraceId === route.traceId
  );
  const snapshot = batch.snapshotsByCanonicalIdentity.get(route.canonicalLocalIdentity);
  const weekly = update?.weekly;
  if (
    !update?.observationId
    || !update.observedAt
    || update.continuity !== "continuous"
    || !weekly?.evidenceId
    || weekly.windowKind !== "weekly"
    || weekly.durationMinutes !== 10_080
    || weekly.schemaVersion !== 2
    || !snapshot?.credentialFingerprint
    || snapshot.identityMismatch
    || snapshot.observationContinuity !== "continuous"
    || snapshot.lastObservationId !== update.observationId
    || snapshot.lastObservationAt !== update.observedAt
    || snapshot.weekly?.evidenceId !== weekly.evidenceId
    || snapshot.weekly.observedAt !== weekly.observedAt
    || snapshot.weekly.credentialFingerprint !== snapshot.credentialFingerprint
  ) return undefined;
  return { proxyAccountKey: snapshot.proxyAccountKey, fingerprint: snapshot.credentialFingerprint, observedAt: update.observedAt };
}

export type RotationReadiness = { compatible: boolean; reason?: string };

export type RotationCoordinatorOptions = {
  canMutate?: boolean;
  readinessCheck?: () => Promise<RotationReadiness>;
  proxyAccountKeyResolver?: (fileName: string) => Promise<string> | string;
};

export class RotationCoordinator {
  readonly #authDir: string;
  readonly #controller: RotationController;
  readonly #canMutate: boolean;
  readonly #readinessCheck?: RotationCoordinatorOptions["readinessCheck"];
  readonly #proxyAccountKeyResolver?: RotationCoordinatorOptions["proxyAccountKeyResolver"];
  #readiness: RotationReadiness = { compatible: true };

  constructor(authDir: string, controller: RotationController, options: RotationCoordinatorOptions = {}) {
    this.#authDir = authDir;
    this.#controller = controller;
    this.#canMutate = options.canMutate ?? false;
    this.#readinessCheck = options.readinessCheck;
    this.#proxyAccountKeyResolver = options.proxyAccountKeyResolver;
  }

  state() {
    return this.#controller.state();
  }

  publicState(): PublicRotationState {
    const state = this.#controller.state();
    return {
      mode: state.mode,
      lifecycle: state.lifecycle,
      pool: state.pool,
      ...(state.routingTargetKey ? { routingTargetKey: state.routingTargetKey } : {}),
      ...(state.observedRoutedAccountKey ? { observedRoutedAccountKey: state.observedRoutedAccountKey } : {}),
      ...(state.evidenceWatermark ? { evidenceWatermark: state.evidenceWatermark } : {}),
      ...(state.lastDecision ? { lastDecision: state.lastDecision } : {}),
      eligibleCount: state.eligibleCount ?? 0,
      provisionalCount: state.provisionalCount ?? 0,
      ...(state.quotaSpread === undefined ? {} : { quotaSpread: state.quotaSpread }),
      journal: {
        phase: state.journal.phase,
        ...(state.journal.routingTargetKey ? { routingTargetKey: state.journal.routingTargetKey } : {}),
        ...(state.journal.intendedPriority === undefined ? {} : { intendedPriority: state.journal.intendedPriority }),
      },
      ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
      ...(state.pauseMessage ? { pauseMessage: state.pauseMessage } : {}),
      manualHold: state.manualHold,
        restorationVerified: state.restorationVerified,
        canActivate: this.canActivate(),
        routingCompatible: this.#readiness.compatible,
        ...(this.#readiness.reason ? { routingCompatibilityMessage: this.#readiness.reason } : {}),
        audit: state.audit,
    };
  }

  async handleObservation(batch: RotationObservationBatch): Promise<void> {
    const observation = latestObservation(batch);
    if (!observation && batch.errors.length === 0) return;
    const controllerState = this.#controller.state();
    const readiness = controllerState.mode === "active" ? await this.refreshReadiness() : this.#readiness;
    const newestRoute = newestCompletedRoute(batch);
    const newestRoutedSnapshot = newestRoute
      ? batch.snapshotsByCanonicalIdentity.get(newestRoute.canonicalLocalIdentity)
      : undefined;
      if (controllerState.manualHold || controllerState.lifecycle === "manual-hold") return;
      if (controllerState.journal.phase === "verified" && batch.errors.length === 0) {
        if (!readiness.compatible) {
          await this.#controller.recordObservationDecision({
            decision: { kind: "pause", reason: readiness.reason ?? "Routing became incompatible during Pending Rotation", pauseReason: "routing-incompatible" },
            observationId: observation?.observationId ?? `routing_incompatible_${Date.now()}`,
            observationAt: observation?.observationAt ?? batch.observedAt,
          });
          return;
        }
        const confirmationRoute = firstCompletedRouteAfter(batch, controllerState.journal.evidenceWatermark);
        if (!confirmationRoute) return;
        const evidence = confirmationEvidence(batch, confirmationRoute);
        if (!controllerState.journal.observationId || !evidence) {
          const routedSnapshot = batch.snapshotsByCanonicalIdentity.get(confirmationRoute.canonicalLocalIdentity);
          await this.#controller.recordObservationDecision({
            decision: { kind: "pause", reason: "Observed Routed Account lacks same-trace identity-bound weekly evidence", pauseReason: "observation-uncertain" },
            observationId: `route_${confirmationRoute.traceId}`,
            observationAt: confirmationRoute.observedAt,
            ...(routedSnapshot ? { observedRoutedAccountKey: routedSnapshot.proxyAccountKey, observedRoutedAt: confirmationRoute.observedAt } : {}),
          });
        return;
      }
      await this.#controller.confirmPendingRotation({
        observationId: controllerState.journal.observationId,
        observedRoutedAccountKey: evidence.proxyAccountKey,
        observedFingerprint: evidence.fingerprint,
        evidenceWatermark: evidence.observedAt,
      });
      return;
    }
    let decision: RotationDecision;
    if (batch.errors.length > 0) {
      decision = { kind: "pause", reason: batch.errors.join("; "), pauseReason: "observation-uncertain" };
    } else {
      const proxyAccountsResult = await readAccounts(this.#authDir);
      const pool = new Map(controllerState.pool.map((member) => [member.proxyAccountKey, member]));
      const proxyAccounts = proxyAccountsResult.accounts.flatMap((proxyAccount) => {
        const snapshot = batch.snapshotsByCanonicalIdentity.get(normalizeProxyAccountLocalIdentity(proxyAccount.fileName));
        const rotationSnapshot = rotationProxyAccount(proxyAccount, snapshot, pool);
        return rotationSnapshot ? [rotationSnapshot] : [];
      });
      const observedRoutedAccountKey = newestRoutedSnapshot?.proxyAccountKey;
      decision = proxyAccountsResult.errors.length > 0
        ? { kind: "pause", reason: proxyAccountsResult.errors.join("; "), pauseReason: "observation-uncertain" }
        : !readiness.compatible
          ? { kind: "pause", reason: readiness.reason ?? "Routing is incompatible with active rotation", pauseReason: "routing-incompatible" }
          : controllerState.mode !== "off"
        && controllerState.routingTargetKey
        && observedRoutedAccountKey
        && observedRoutedAccountKey !== controllerState.routingTargetKey
        ? { kind: "pause", reason: "Observed Routed Account does not match intended target", pauseReason: "selection-mismatch" }
        : decideRotation({
            accounts: proxyAccounts,
            routingTargetKey: controllerState.routingTargetKey ?? observedRoutedAccountKey,
            nowMs: Date.now(),
            recentAutomaticSwitches: controllerState.switchTimestamps,
            observationId: observation!.observationId,
            observationAt: observation!.observationAt,
            mode: controllerState.mode,
            seenObservationIds: controllerState.lastObservationId ? [controllerState.lastObservationId] : [],
            evidenceWatermark: controllerState.evidenceWatermark,
          });
      const selectedTarget = decision.targetKey
        ? proxyAccounts.find((proxyAccount) => proxyAccount.proxyAccountKey === decision.targetKey)
        : undefined;
      if (decision.kind === "switch" && !selectedTarget) {
        decision = { kind: "pause", reason: "Rotation target disappeared before mutation", pauseReason: "selection-mismatch" };
      }
      const eligibleCount = proxyAccounts.filter((proxyAccount) => isRotationEligible(proxyAccount, Date.now())).length;
      const provisionalCount = proxyAccounts.filter((proxyAccount) => proxyAccount.provisionalReset).length;
      await this.#controller.recordObservationDecision({
        decision,
        observationId: observation!.observationId,
        observationAt: observation!.observationAt,
        ...(observedRoutedAccountKey && newestRoute ? { observedRoutedAccountKey, observedRoutedAt: newestRoute.observedAt } : {}),
        eligibleCount,
        provisionalCount,
      });
      if (
        decision.kind === "switch"
        && selectedTarget
        && controllerState.mode === "active"
        && controllerState.lifecycle === "active"
      ) {
        await this.#controller.beginPendingRotation({
          observationId: observation!.observationId,
          evidenceWatermark: observation!.observationAt,
          ...(controllerState.routingTargetKey ?? observedRoutedAccountKey
            ? { fromProxyAccountKey: controllerState.routingTargetKey ?? observedRoutedAccountKey }
            : {}),
          routingTargetKey: selectedTarget.proxyAccountKey,
          targetFingerprint: selectedTarget.identityFingerprint,
        });
      }
      return;
    }
    await this.#controller.recordObservationDecision({
      decision,
      observationId: observation?.observationId ?? `observer_error_${Date.now()}`,
      observationAt: observation?.observationAt ?? batch.observedAt,
      ...(newestRoutedSnapshot && newestRoute ? {
        observedRoutedAccountKey: newestRoutedSnapshot.proxyAccountKey,
        observedRoutedAt: newestRoute.observedAt,
      } : {}),
    });
  }

  canActivate(): boolean {
    return this.#canMutate && this.#readiness.compatible;
  }

  async refreshReadiness(): Promise<RotationReadiness> {
    if (!this.#readinessCheck) return this.#readiness;
    try {
      this.#readiness = await this.#readinessCheck();
    } catch (error) {
      this.#readiness = { compatible: false, reason: error instanceof Error ? error.message : String(error) };
    }
    return this.#readiness;
  }

  async setMode(mode: RotationMode): Promise<RotationState> {
      if (mode === "active") {
        if (!this.#canMutate) throw new Error("CLIProxy management key is required before active rotation");
        const readiness = await this.refreshReadiness();
        if (!readiness.compatible) throw new Error(readiness.reason ?? "Routing is incompatible with active rotation");
      }
      return await this.#controller.setMode(mode);
  }

  async upsertPoolMember(input: { proxyAccountKey: string; fileName: string; exclusivityAttested: boolean }): Promise<RotationState> {
      if (!input.exclusivityAttested) throw new Error("Proxy exclusivity attestation is required");
      if (this.#proxyAccountKeyResolver) {
        const resolvedKey = (await this.#proxyAccountKeyResolver(input.fileName)).trim();
        if (!resolvedKey || resolvedKey !== input.proxyAccountKey) {
          throw new Error(`Proxy Account Key does not match file name: ${input.fileName}`);
        }
      }
      return await this.#controller.updatePool((pool) => {
        const member = {
          proxyAccountKey: input.proxyAccountKey,
          fileName: input.fileName,
          exclusivityAttested: true,
          addedAt: pool.find((value) => value.proxyAccountKey === input.proxyAccountKey)?.addedAt ?? new Date().toISOString(),
        };
        return [...pool.filter((value) => value.proxyAccountKey !== input.proxyAccountKey), member];
      });
  }

  async removePoolMember(proxyAccountKey: string): Promise<RotationState> {
      return await this.#controller.updatePool((pool) => pool.filter((member) => member.proxyAccountKey !== proxyAccountKey));
  }

  async enterManualHold(message: string): Promise<RotationState> {
    return await this.#controller.enterManualHold(message);
  }

  async resume(): Promise<RotationState> {
      return await this.#controller.resume();
  }

  async recover(): Promise<RotationState> {
    const recovered = await this.#controller.recover();
    if (recovered.journal.phase !== "idle" && (recovered.lifecycle === "paused" || recovered.lifecycle === "recovery-required")) {
      throw new Error(recovered.pauseMessage ?? "Rotation recovery requires manual state repair");
    }
    const state = await this.#controller.disable();
    if (state.lifecycle !== "off") throw new Error(state.pauseMessage ?? "Rotation recovery requires manual state repair");
    return state;
  }

  async pause(message: string): Promise<RotationState> {
    const observedAt = new Date().toISOString();
    return await this.#controller.recordObservationDecision({
      decision: { kind: "pause", reason: message, pauseReason: "observation-uncertain" },
      observationId: `operator_pause_${Date.now()}`,
      observationAt: observedAt,
    });
  }

  async close(): Promise<void> {
    await this.#controller.close();
  }
}

export async function createRotationCoordinator(options: DashboardOptions): Promise<RotationCoordinator> {
  const paths = await resolveDashboardPaths(options);
  const statePath = path.join(path.dirname(paths.quotaSnapshotStatePath), "rotation-controller.json");
  const identityForFile = async (fileName: string) => {
    const raw = await readJsonObject(resolveAccountPath(paths.authDir, fileName));
    if (!raw) throw new Error(`Proxy Account credentials unavailable: ${fileName}`);
    const { store } = await readQuotaSnapshotStoreFile(paths.quotaSnapshotStatePath);
    const canonicalLocalIdentity = normalizeProxyAccountLocalIdentity(fileName);
    return {
      proxyAccountKey: deriveProxyAccountKey(store, canonicalLocalIdentity),
      fingerprint: deriveCredentialFingerprint(store.keyDerivation.secret, fileName, raw),
    };
  };
  const writer = options.managementKey
    ? createCliProxyManagementWriter({
        baseUrl: paths.proxyUrl,
        managementKey: options.managementKey,
        fingerprintResolver: async (fileName) => (await identityForFile(fileName)).fingerprint,
        proxyAccountKeyResolver: async (fileName) => (await identityForFile(fileName)).proxyAccountKey,
      })
    : undefined;
    const readinessCheck = async (): Promise<RotationReadiness> => {
      const config = await readConfig(paths.configPath);
      if (!config) return { compatible: false, reason: "CLIProxy routing configuration is unreadable" };
      if (config.routingStrategy !== "fill-first" || config.sessionAffinity) {
        return { compatible: false, reason: "fill-first routing with session affinity disabled is required" };
      }
      return { compatible: true };
    };
    const controller = await openRotationController({ statePath, writer });
    const coordinator = new RotationCoordinator(paths.authDir, controller, {
      canMutate: Boolean(writer),
      readinessCheck,
      proxyAccountKeyResolver: async (fileName) => (await identityForFile(fileName)).proxyAccountKey,
    });
    await coordinator.refreshReadiness();
    return coordinator;
  }
