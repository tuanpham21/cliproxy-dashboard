import { createHmac } from "node:crypto";
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
import { deriveCredentialFingerprint, decideRotation, isProvisionalResetCandidate, isRotationEligible } from "./rotation-policy.js";
import { deriveProxyAccountKey, readQuotaSnapshotStoreFile } from "./quota-store.js";
import { evaluateRotationObservationConsumption } from "./rotation-state-transitions.js";
import type { ProvisionalResetAttempt, RotationAccountSnapshot, RotationDecision, RotationMode, RotationState, SemanticQuotaEvidence } from "./rotation-types.js";
import type { AccountView, DashboardOptions, PersistedQuotaSnapshot, PersistedQuotaWindowEvidence } from "./types.js";
import { normalizeProxyAccountLocalIdentity } from "./util.js";

function deriveManagementEntryFingerprint(secret: string, fileName: string, revision: string): string {
  const digest = createHmac("sha256", Buffer.from(secret, "base64url"))
    .update("cliproxy-dashboard management-entry-fingerprint v1\0")
    .update(normalizeProxyAccountLocalIdentity(fileName), "utf8")
    .update("\0")
    .update(revision, "utf8")
    .digest("base64url");
  return `mef_v1_${digest}`;
}

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
  nowMs: number,
  lastSelectedAt?: number,
): RotationAccountSnapshot | null {
  if (!snapshot) return null;
  const membership = pool.get(snapshot.proxyAccountKey);
  const weekly = semanticWeekly(snapshot.weekly, snapshot);
  const rotationAccount: RotationAccountSnapshot = {
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
    ...(lastSelectedAt === undefined ? {} : { lastSelectedAt }),
    priority: proxyAccount.priority,
    explicitPriority: proxyAccount.explicitPriority,
  };
  if (isProvisionalResetCandidate(rotationAccount, nowMs)) rotationAccount.provisionalReset = true;
  return rotationAccount;
}

type RotationObservation = { observationId: string; observationAt: string };

function batchObservations(batch: RotationObservationBatch): RotationObservation[] {
  const matchedRouteTraceIds = new Set<string>();
  const observations = batch.updates.flatMap((update): RotationObservation[] => {
    if (!update.observationId || !update.observedAt) return [];
    if (update.routeTraceId) matchedRouteTraceIds.add(update.routeTraceId);
    return [{ observationId: update.observationId, observationAt: update.observedAt }];
  });
  observations.push(...batch.completedRoutes.flatMap((route): RotationObservation[] =>
    matchedRouteTraceIds.has(route.traceId)
      ? []
      : [{ observationId: `route_${route.traceId}`, observationAt: route.observedAt }],
  ));
  return observations.sort((left, right) => {
    const byTime = Date.parse(left.observationAt) - Date.parse(right.observationAt);
    return byTime || left.observationId.localeCompare(right.observationId);
  });
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

function evaluateProvisionalReset(
  batch: RotationObservationBatch,
  accounts: RotationAccountSnapshot[],
  routingTargetKey: string | undefined,
  attempt: ProvisionalResetAttempt | undefined,
  evidenceWatermark: string,
  nowMs: number,
): { decision?: RotationDecision; attemptUpdate?: ProvisionalResetAttempt | null } {
  if (attempt) {
    const target = accounts.find((account) => account.proxyAccountKey === attempt.proxyAccountKey);
    if (!target) return { decision: { kind: "pause", reason: "Provisional Reset Candidate disappeared", pauseReason: "selection-mismatch" } };
    if (target.identityFingerprint !== attempt.credentialFingerprint) {
      return { decision: { kind: "pause", reason: "Provisional Reset Candidate identity changed", pauseReason: "identity-mismatch" } };
    }
    const route = firstCompletedRouteAfter(batch, attempt.evidenceWatermark);
    if (!route) return { decision: { kind: "hold", reason: "Provisional Reset Candidate awaits its one normal confirmation request" } };
    const evidence = confirmationEvidence(batch, route);
    if (!evidence) {
      return { decision: { kind: "pause", reason: "Provisional Reset Candidate normal request lacked same-trace fresh weekly evidence", pauseReason: "observation-uncertain" } };
    }
    if (evidence.proxyAccountKey !== attempt.proxyAccountKey) {
      return { decision: { kind: "pause", reason: "Provisional Reset Candidate request routed to an unexpected account", pauseReason: "selection-mismatch" } };
    }
    if (evidence.fingerprint !== attempt.credentialFingerprint) {
      return { decision: { kind: "pause", reason: "Provisional Reset Candidate evidence identity changed", pauseReason: "identity-mismatch" } };
    }
    if (Date.parse(evidence.observedAt) <= Date.parse(attempt.resetAt) || !isRotationEligible(target, nowMs)) {
      return { decision: { kind: "pause", reason: "Provisional Reset Candidate confirmation evidence is not fresh and eligible", pauseReason: "observation-uncertain" } };
    }
    return { attemptUpdate: null };
  }
  const target = accounts.find((account) => account.proxyAccountKey === routingTargetKey);
  if (!target?.provisionalReset || !target.weekly?.resetAt) return {};
  return {
    decision: { kind: "hold", reason: "Provisional Reset Candidate may receive one normal confirmation request" },
    attemptUpdate: {
      proxyAccountKey: target.proxyAccountKey,
      credentialFingerprint: target.identityFingerprint,
      resetAt: target.weekly.resetAt,
      evidenceWatermark,
    },
  };
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
      ...(state.provisionalResetAttempt ? {
        provisionalResetAttempt: {
          proxyAccountKey: state.provisionalResetAttempt.proxyAccountKey,
          resetAt: state.provisionalResetAttempt.resetAt,
          evidenceWatermark: state.provisionalResetAttempt.evidenceWatermark,
        },
      } : {}),
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
    const observations = batchObservations(batch);
    for (const observation of observations.slice(0, -1)) {
      await this.#recordCoalescedObservation(observation);
    }
    await this.#handleObservationWorkItem(batch, observations.at(-1) ?? null);
  }

  async #recordCoalescedObservation(observation: RotationObservation): Promise<void> {
    const controllerState = this.#controller.state();
    if (controllerState.manualHold || controllerState.lifecycle === "manual-hold") return;
    const observationConsumption = evaluateRotationObservationConsumption(controllerState, observation);
    if (observationConsumption.disposition === "duplicate" || observationConsumption.disposition === "stale") return;
    await this.#controller.recordObservationDecision({
      decision: observationConsumption.disposition === "overflow"
        ? {
            kind: "pause",
            reason: "Evidence watermark observation ID capacity exceeded",
            pauseReason: "observation-uncertain",
          }
        : { kind: "hold", reason: "observation coalesced into later batch evidence" },
      observationId: observation.observationId,
      observationAt: observation.observationAt,
    });
  }

  async #handleObservationWorkItem(
    batch: RotationObservationBatch,
    observation: RotationObservation | null,
  ): Promise<void> {
    if (!observation && batch.errors.length === 0) return;
    const controllerState = this.#controller.state();
    const observationConsumption = evaluateRotationObservationConsumption(controllerState, observation ?? undefined);
    const seenObservationIds = observationConsumption.consumedObservationIds;
    if (observation && batch.errors.length === 0) {
      if (observationConsumption.disposition === "duplicate" || observationConsumption.disposition === "stale") return;
      if (observationConsumption.disposition === "overflow") {
        await this.#controller.recordObservationDecision({
          decision: {
            kind: "pause",
            reason: "Evidence watermark observation ID capacity exceeded",
            pauseReason: "observation-uncertain",
          },
          observationId: observation.observationId,
          observationAt: observation.observationAt,
        });
        return;
      }
    }
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
    let provisionalResetAttemptUpdate: ProvisionalResetAttempt | null | undefined;
    if (batch.errors.length > 0) {
      decision = { kind: "pause", reason: batch.errors.join("; "), pauseReason: "observation-uncertain" };
    } else {
      const proxyAccountsResult = await readAccounts(this.#authDir);
      const pool = new Map(controllerState.pool.map((member) => [member.proxyAccountKey, member]));
      const decisionAtMs = Date.now();
      const proxyAccounts = proxyAccountsResult.accounts.flatMap((proxyAccount) => {
        const snapshot = batch.snapshotsByCanonicalIdentity.get(normalizeProxyAccountLocalIdentity(proxyAccount.fileName));
        const rotationSnapshot = rotationProxyAccount(
          proxyAccount,
          snapshot,
          pool,
          decisionAtMs,
          snapshot ? controllerState.lastSelectedAtByProxyAccountKey?.[snapshot.proxyAccountKey] : undefined,
        );
        return rotationSnapshot ? [rotationSnapshot] : [];
      });
      const observedRoutedAccountKey = newestRoutedSnapshot?.proxyAccountKey;
      const routingTargetKey = controllerState.routingTargetKey ?? observedRoutedAccountKey;
      if (proxyAccountsResult.errors.length > 0) {
        decision = { kind: "pause", reason: proxyAccountsResult.errors.join("; "), pauseReason: "observation-uncertain" };
      } else if (!readiness.compatible) {
        decision = { kind: "pause", reason: readiness.reason ?? "Routing is incompatible with active rotation", pauseReason: "routing-incompatible" };
      } else if (
        controllerState.mode !== "off"
        && controllerState.routingTargetKey
        && observedRoutedAccountKey
        && observedRoutedAccountKey !== controllerState.routingTargetKey
      ) {
        decision = { kind: "pause", reason: "Observed Routed Account does not match intended target", pauseReason: "selection-mismatch" };
      } else {
        const provisionalReset = evaluateProvisionalReset(
          batch,
          proxyAccounts,
          routingTargetKey,
          controllerState.provisionalResetAttempt,
          observation!.observationAt,
          decisionAtMs,
        );
        provisionalResetAttemptUpdate = provisionalReset.attemptUpdate;
        decision = provisionalReset.decision ?? decideRotation({
            accounts: proxyAccounts,
            routingTargetKey,
            nowMs: decisionAtMs,
            recentAutomaticSwitches: controllerState.switchTimestamps,
            observationId: observation!.observationId,
            observationAt: observation!.observationAt,
            mode: controllerState.mode,
            seenObservationIds,
            evidenceWatermark: controllerState.evidenceWatermark,
          });
      }
      const selectedTarget = decision.targetKey
        ? proxyAccounts.find((proxyAccount) => proxyAccount.proxyAccountKey === decision.targetKey)
        : undefined;
      if (decision.kind === "switch" && !selectedTarget) {
        decision = { kind: "pause", reason: "Rotation target disappeared before mutation", pauseReason: "selection-mismatch" };
      }
      const eligibleCount = proxyAccounts.filter((proxyAccount) => isRotationEligible(proxyAccount, decisionAtMs)).length;
      const provisionalCount = proxyAccounts.filter((proxyAccount) => proxyAccount.provisionalReset).length;
      await this.#controller.recordObservationDecision({
        decision,
        observationId: observation!.observationId,
        observationAt: observation!.observationAt,
        ...(observedRoutedAccountKey && newestRoute ? { observedRoutedAccountKey, observedRoutedAt: newestRoute.observedAt } : {}),
        eligibleCount,
        provisionalCount,
        ...(provisionalResetAttemptUpdate === undefined ? {} : { provisionalResetAttempt: provisionalResetAttemptUpdate }),
      });
      const currentControllerState = this.#controller.state();
      if (
        decision.kind === "switch"
        && selectedTarget
        && currentControllerState.mode === "active"
        && currentControllerState.lifecycle === "active"
      ) {
        const fromProxyAccountKey = currentControllerState.routingTargetKey ?? observedRoutedAccountKey;
        await this.#controller.beginPendingRotation({
          observationId: observation!.observationId,
          evidenceWatermark: observation!.observationAt,
          ...(fromProxyAccountKey ? { fromProxyAccountKey } : {}),
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
  const proxyAccountKeyForFile = async (fileName: string) => {
    const { store } = await readQuotaSnapshotStoreFile(paths.quotaSnapshotStatePath);
    return deriveProxyAccountKey(store, normalizeProxyAccountLocalIdentity(fileName));
  };
  const credentialFingerprintForFile = async (fileName: string) => {
    const raw = await readJsonObject(resolveAccountPath(paths.authDir, fileName));
    if (!raw) return undefined;
    const { store } = await readQuotaSnapshotStoreFile(paths.quotaSnapshotStatePath);
    return deriveCredentialFingerprint(store.keyDerivation.secret, fileName, raw);
  };
  const managementEntryFingerprintForFile = async (fileName: string, revision: string) => {
    const { store } = await readQuotaSnapshotStoreFile(paths.quotaSnapshotStatePath);
    return deriveManagementEntryFingerprint(store.keyDerivation.secret, fileName, revision);
  };
  const writer = options.managementKey
    ? createCliProxyManagementWriter({
        baseUrl: paths.proxyUrl,
        managementKey: options.managementKey,
        fingerprintResolver: credentialFingerprintForFile,
        managementOnlyFingerprintResolver: managementEntryFingerprintForFile,
        proxyAccountKeyResolver: proxyAccountKeyForFile,
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
      proxyAccountKeyResolver: proxyAccountKeyForFile,
    });
    await coordinator.refreshReadiness();
    return coordinator;
  }
