import { randomUUID } from "node:crypto";

import type {
  RotationAuditEvent,
  RotationDecision,
  RotationMode,
  RotationPoolMember,
  ProvisionalResetAttempt,
  RotationState,
} from "./rotation-types.js";
import { MAX_EVIDENCE_WATERMARK_OBSERVATION_IDS } from "./rotation-types.js";

const MAX_AUDIT_EVENTS = 200;

export function appendRotationAudit(state: RotationState, event: Omit<RotationAuditEvent, "id">): void {
  state.audit = [...state.audit, { id: randomUUID(), ...event }].slice(-MAX_AUDIT_EVENTS);
}

function consumedObservationIds(state: RotationState): string[] {
  return [...new Set([
    ...(state.evidenceWatermarkObservationIds ?? []),
    ...(state.lastObservationId ? [state.lastObservationId] : []),
  ])];
}

export function evaluateRotationObservationConsumption(
  state: RotationState,
  observation?: { observationId: string; observationAt: string },
): {
  disposition: "accept" | "duplicate" | "stale" | "overflow";
  consumedObservationIds: string[];
} {
  const observationIds = consumedObservationIds(state);
  if (!observation) return { disposition: "accept", consumedObservationIds: observationIds };
  if (observationIds.includes(observation.observationId)) {
    return { disposition: "duplicate", consumedObservationIds: observationIds };
  }
  const observationMs = Date.parse(observation.observationAt);
  const watermarkMs = Date.parse(state.evidenceWatermark ?? "");
  if (Number.isFinite(observationMs) && Number.isFinite(watermarkMs) && observationMs < watermarkMs) {
    return { disposition: "stale", consumedObservationIds: observationIds };
  }
  if (
    Number.isFinite(observationMs)
    && Number.isFinite(watermarkMs)
    && observationMs === watermarkMs
    && observationIds.length >= MAX_EVIDENCE_WATERMARK_OBSERVATION_IDS
  ) {
    return { disposition: "overflow", consumedObservationIds: observationIds };
  }
  return { disposition: "accept", consumedObservationIds: observationIds };
}

export function recordObservationDecisionState(
  state: RotationState,
  input: {
    decision: RotationDecision;
    observationId: string;
    observationAt: string;
    observedRoutedAccountKey?: string;
    observedRoutedAt?: string;
    eligibleCount: number;
    provisionalCount: number;
    provisionalResetAttempt?: ProvisionalResetAttempt | null;
  },
  nowMs: number,
): void {
  const observedMs = Date.parse(input.observationAt);
  const watermarkMs = Date.parse(state.evidenceWatermark ?? "");
  const observedRouteMs = Date.parse(input.observedRoutedAt ?? "");
  if (
    input.observedRoutedAccountKey
    && Number.isFinite(observedRouteMs)
    && (!Number.isFinite(watermarkMs) || observedRouteMs > watermarkMs)
  ) state.observedRoutedAccountKey = input.observedRoutedAccountKey;
  if (Number.isFinite(observedMs)) {
    if (!Number.isFinite(watermarkMs) || observedMs > watermarkMs) {
      state.lastObservationId = input.observationId;
      state.evidenceWatermark = new Date(observedMs).toISOString();
      state.evidenceWatermarkObservationIds = [input.observationId];
    } else if (observedMs === watermarkMs) {
      const watermarkIds = consumedObservationIds(state);
      if (!watermarkIds.includes(input.observationId) && watermarkIds.length < MAX_EVIDENCE_WATERMARK_OBSERVATION_IDS) {
        state.evidenceWatermarkObservationIds = [...watermarkIds, input.observationId];
        state.lastObservationId = input.observationId;
      }
    }
  }
  state.lastDecision = input.decision;
  state.eligibleCount = input.eligibleCount;
  state.provisionalCount = input.provisionalCount;
  state.quotaSpread = input.decision.spread;
  if (input.provisionalResetAttempt !== undefined) {
    state.provisionalResetAttempt = input.provisionalResetAttempt ?? undefined;
  }
  appendRotationAudit(state, {
    at: new Date(nowMs).toISOString(),
    kind: "decision",
    message: input.decision.reason,
    observationId: input.observationId,
    ...(input.decision.targetKey ? { proxyAccountKey: input.decision.targetKey } : {}),
    ...(input.decision.pauseReason ? { pauseReason: input.decision.pauseReason } : {}),
  });
  if (input.decision.kind === "pause") {
    state.lifecycle = "paused";
    state.pauseReason = input.decision.pauseReason ?? "observation-uncertain";
    state.pauseMessage = input.decision.reason;
  }
}

export function setRotationModeState(state: RotationState, mode: Exclude<RotationMode, "off">, nowMs: number): void {
  state.mode = mode;
  if (state.lifecycle === "paused" || state.lifecycle === "recovery-required") {
    appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "hold", message: `Quota-Balanced Rotation mode selected as ${mode}; explicit Resume still required` });
    return;
  }
  state.lifecycle = state.manualHold ? "manual-hold" : mode;
  state.pauseReason = undefined;
  state.pauseMessage = undefined;
  appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "resume", message: `Quota-Balanced Rotation mode set to ${mode}` });
}

export function replaceRotationPoolState(state: RotationState, pool: RotationPoolMember[], nowMs: number): void {
  state.pool = structuredClone(pool);
  if (state.provisionalResetAttempt && !pool.some((member) => member.proxyAccountKey === state.provisionalResetAttempt?.proxyAccountKey)) {
    state.provisionalResetAttempt = undefined;
  }
  appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "observation", message: `Rotation Pool updated: ${pool.length} member(s)` });
}

export function enterManualHoldState(state: RotationState, message: string, nowMs: number): void {
  state.manualHold = true;
  state.provisionalResetAttempt = undefined;
  state.lifecycle = "manual-hold";
  state.pauseReason = undefined;
  state.pauseMessage = undefined;
  appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "hold", message });
}

export function resumeRotationState(state: RotationState, nowMs: number): void {
  state.manualHold = false;
  state.provisionalResetAttempt = undefined;
  state.lifecycle = state.mode === "off" ? "off" : state.mode;
  state.pauseReason = undefined;
  state.pauseMessage = undefined;
  state.journal = { phase: "idle" };
  state.overlay = undefined;
  state.restorationVerified = true;
  appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "resume", message: "Automatic balancing resumed from current operator configuration" });
}
