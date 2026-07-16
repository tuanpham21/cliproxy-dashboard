import { randomUUID } from "node:crypto";

import type {
  RotationAuditEvent,
  RotationDecision,
  RotationMode,
  RotationPoolMember,
  RotationState,
} from "./rotation-types.js";

const MAX_AUDIT_EVENTS = 200;

export function appendRotationAudit(state: RotationState, event: Omit<RotationAuditEvent, "id">): void {
  state.audit = [...state.audit, { id: randomUUID(), ...event }].slice(-MAX_AUDIT_EVENTS);
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
  if (Number.isFinite(observedMs) && (!Number.isFinite(watermarkMs) || observedMs > watermarkMs)) {
    state.lastObservationId = input.observationId;
    state.evidenceWatermark = new Date(observedMs).toISOString();
  }
  state.lastDecision = input.decision;
  state.eligibleCount = input.eligibleCount;
  state.provisionalCount = input.provisionalCount;
  state.quotaSpread = input.decision.spread;
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
  appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "observation", message: `Rotation Pool updated: ${pool.length} member(s)` });
}

export function enterManualHoldState(state: RotationState, message: string, nowMs: number): void {
  state.manualHold = true;
  state.lifecycle = "manual-hold";
  state.pauseReason = undefined;
  state.pauseMessage = undefined;
  appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "hold", message });
}

export function resumeRotationState(state: RotationState, nowMs: number): void {
  state.manualHold = false;
  state.lifecycle = state.mode === "off" ? "off" : state.mode;
  state.pauseReason = undefined;
  state.pauseMessage = undefined;
  state.journal = { phase: "idle" };
  state.overlay = undefined;
  state.restorationVerified = true;
  appendRotationAudit(state, { at: new Date(nowMs).toISOString(), kind: "resume", message: "Automatic balancing resumed from current operator configuration" });
}
