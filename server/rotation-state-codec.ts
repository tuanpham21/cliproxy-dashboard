import {
  ROTATION_JOURNAL_PHASES,
  ROTATION_LIFECYCLES,
  ROTATION_MODES,
  ROTATION_PAUSE_REASONS,
  type RotationJournal,
  type RotationDecision,
  type RotationPauseReason,
  type RotationPrioritySnapshot,
  type RotationPrioritySnapshots,
  type RotationState,
} from "./rotation-types.js";

export const MAX_ROTATION_PRIORITY = 2_147_483_647;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function isPriorityValue(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_ROTATION_PRIORITY;
}

function isPrioritySnapshot(value: unknown): value is RotationPrioritySnapshot {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.fileName) || typeof value.present !== "boolean") return false;
  if (!isNonEmptyString(value.fingerprint) || typeof value.disabled !== "boolean" || typeof value.note !== "string") return false;
  return value.present ? isPriorityValue(value.value) : value.value === undefined;
}

function isPrioritySnapshots(value: unknown): value is RotationPrioritySnapshots {
  return isRecord(value) && Object.entries(value).every(([key, entry]) => key.length > 0 && isPrioritySnapshot(entry));
}

function prioritySnapshotsEqual(left: RotationPrioritySnapshots, right: RotationPrioritySnapshots): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => {
    const a = left[key];
    const b = right[key];
    return Boolean(
      b
      && a.fileName === b.fileName
      && a.present === b.present
      && a.value === b.value
      && a.fingerprint === b.fingerprint
      && a.disabled === b.disabled
      && a.note === b.note,
    );
  });
}

function transactionLedgersCoverTarget(
  basePriorities: RotationPrioritySnapshots,
  previousPriorities: RotationPrioritySnapshots,
  routingTargetKey: string,
  targetFingerprint: string,
): boolean {
  const baseKeys = Object.keys(basePriorities);
  if (baseKeys.length === 0 || baseKeys.length !== Object.keys(previousPriorities).length) return false;
  if (!basePriorities[routingTargetKey] || !previousPriorities[routingTargetKey]) return false;
  if (basePriorities[routingTargetKey].fingerprint !== targetFingerprint || previousPriorities[routingTargetKey].fingerprint !== targetFingerprint) return false;
  return baseKeys.every((proxyAccountKey) => {
    const base = basePriorities[proxyAccountKey];
    const previous = previousPriorities[proxyAccountKey];
    return Boolean(
      previous
      && base.fileName === previous.fileName
      && base.fingerprint === previous.fingerprint
      && base.disabled === previous.disabled
      && base.note === previous.note,
    );
  });
}

function isOverlay(value: unknown): value is NonNullable<RotationState["overlay"]> {
  if (!isRecord(value)) return false;
  const basePriorities = value.basePriorities;
  const appliedPriorities = value.appliedPriorities;
  if (!isPrioritySnapshots(basePriorities) || !isRecord(appliedPriorities)) return false;
  return Object.entries(appliedPriorities).every(([key, priority]) => key in basePriorities && isPriorityValue(priority));
}

function isJournal(value: unknown): value is RotationJournal {
  if (!isRecord(value) || !(ROTATION_JOURNAL_PHASES as readonly unknown[]).includes(value.phase)) return false;
  for (const field of ["observationId", "fromProxyAccountKey", "routingTargetKey", "targetFingerprint", "targetRevision"] as const) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) return false;
  }
  if (value.evidenceWatermark !== undefined && !isTimestamp(value.evidenceWatermark)) return false;
  if (value.intendedPriority !== undefined && !isPriorityValue(value.intendedPriority)) return false;
  if (value.basePriorities !== undefined && !isPrioritySnapshots(value.basePriorities)) return false;
  if (value.previousPriorities !== undefined && !isPrioritySnapshots(value.previousPriorities)) return false;
  if (value.restoreIntent !== undefined && value.restoreIntent !== "rollback" && value.restoreIntent !== "disable") return false;
  if (value.updatedAt !== undefined && !isTimestamp(value.updatedAt)) return false;

  const hasPendingTransaction = isNonEmptyString(value.observationId)
    && isNonEmptyString(value.routingTargetKey)
    && isNonEmptyString(value.targetFingerprint)
    && isTimestamp(value.evidenceWatermark)
    && isPriorityValue(value.intendedPriority)
    && isPrioritySnapshots(value.basePriorities)
    && isPrioritySnapshots(value.previousPriorities)
    && isTimestamp(value.updatedAt)
    && transactionLedgersCoverTarget(value.basePriorities, value.previousPriorities, value.routingTargetKey, value.targetFingerprint);
  if (value.phase === "idle") {
    return value.observationId === undefined
      && value.fromProxyAccountKey === undefined
      && value.routingTargetKey === undefined
      && value.targetFingerprint === undefined
      && value.targetRevision === undefined
      && value.evidenceWatermark === undefined
      && value.intendedPriority === undefined
      && value.basePriorities === undefined
      && value.previousPriorities === undefined
      && value.restoreIntent === undefined
      && value.updatedAt === undefined;
  }
  if (value.phase === "journaled" || value.phase === "mutating") return hasPendingTransaction;
  if (value.phase === "mutated" || value.phase === "verified" || value.phase === "committed") {
    return hasPendingTransaction && isNonEmptyString(value.targetRevision);
  }
  if (value.restoreIntent === "disable") return isPrioritySnapshots(value.basePriorities);
  return value.restoreIntent === "rollback" && hasPendingTransaction;
}

function isPauseReason(value: unknown): value is RotationPauseReason {
  return (ROTATION_PAUSE_REASONS as readonly unknown[]).includes(value);
}

function isPoolMember(value: unknown): value is RotationState["pool"][number] {
  return isRecord(value)
    && isNonEmptyString(value.proxyAccountKey)
    && isNonEmptyString(value.fileName)
    && typeof value.exclusivityAttested === "boolean"
    && isTimestamp(value.addedAt);
}

function isAuditEvent(value: unknown): value is RotationState["audit"][number] {
  if (!isRecord(value) || !isNonEmptyString(value.id) || !isTimestamp(value.at) || typeof value.message !== "string") return false;
  if (!(["decision", "switch", "pause", "hold", "resume", "restore", "observation"] as unknown[]).includes(value.kind)) return false;
  if (value.proxyAccountKey !== undefined && !isNonEmptyString(value.proxyAccountKey)) return false;
  if (value.observationId !== undefined && !isNonEmptyString(value.observationId)) return false;
  return value.pauseReason === undefined || isPauseReason(value.pauseReason);
}

function isDecision(value: unknown): value is RotationDecision {
  if (!isRecord(value) || !(["switch", "hold", "pause", "confirm"] as unknown[]).includes(value.kind) || typeof value.reason !== "string") return false;
  if (value.targetKey !== undefined && !isNonEmptyString(value.targetKey)) return false;
  for (const field of ["activeUsedPercent", "lowestUsedPercent", "spread"] as const) {
    if (value[field] !== undefined && (typeof value[field] !== "number" || !Number.isFinite(value[field]))) return false;
  }
  return value.pauseReason === undefined || isPauseReason(value.pauseReason);
}

export function isRotationState(value: unknown): value is RotationState {
  if (!isRecord(value) || value.schemaVersion !== 1) return false;
  if (!(ROTATION_MODES as readonly unknown[]).includes(value.mode)) return false;
  if (!(ROTATION_LIFECYCLES as readonly unknown[]).includes(value.lifecycle)) return false;
  if (!Array.isArray(value.pool) || !value.pool.every(isPoolMember)) return false;
  if (!Array.isArray(value.audit) || !value.audit.every(isAuditEvent)) return false;
  if (!Array.isArray(value.switchTimestamps) || !value.switchTimestamps.every((timestamp) => Number.isSafeInteger(timestamp) && timestamp >= 0)) return false;
  if (typeof value.manualHold !== "boolean" || typeof value.restorationVerified !== "boolean") return false;
  const journal = value.journal;
  const overlay = value.overlay;
  if (!isJournal(journal) || (overlay !== undefined && !isOverlay(overlay))) return false;
  for (const field of ["routingTargetKey", "observedRoutedAccountKey", "lastObservationId"] as const) {
    if (value[field] !== undefined && !isNonEmptyString(value[field])) return false;
  }
  if (value.pauseMessage !== undefined && typeof value.pauseMessage !== "string") return false;
  if (value.evidenceWatermark !== undefined && !isTimestamp(value.evidenceWatermark)) return false;
  if (value.pauseReason !== undefined && !isPauseReason(value.pauseReason)) return false;
  if (value.lastDecision !== undefined && !isDecision(value.lastDecision)) return false;
  if (value.eligibleCount !== undefined && (typeof value.eligibleCount !== "number" || !Number.isSafeInteger(value.eligibleCount) || value.eligibleCount < 0)) return false;
  if (value.provisionalCount !== undefined && (typeof value.provisionalCount !== "number" || !Number.isSafeInteger(value.provisionalCount) || value.provisionalCount < 0)) return false;
  if (value.quotaSpread !== undefined && (typeof value.quotaSpread !== "number" || !Number.isFinite(value.quotaSpread))) return false;
  if ((value.pauseReason === undefined) !== (value.pauseMessage === undefined)) return false;
  if (journal.phase === "committed") {
    return Boolean(
      overlay
      && journal.routingTargetKey
      && journal.observationId
      && journal.intendedPriority !== undefined
      && journal.basePriorities
      && value.routingTargetKey === journal.routingTargetKey
      && value.observedRoutedAccountKey === journal.routingTargetKey
      && value.lastObservationId === journal.observationId
      && isTimestamp(value.evidenceWatermark)
      && Date.parse(value.evidenceWatermark) > Date.parse(journal.evidenceWatermark ?? "")
      && overlay.appliedPriorities[journal.routingTargetKey] === journal.intendedPriority
      && prioritySnapshotsEqual(overlay.basePriorities, journal.basePriorities),
    );
  }
  if (journal.phase === "restoring" && journal.restoreIntent === "disable") {
    return Boolean(overlay && journal.basePriorities && prioritySnapshotsEqual(overlay.basePriorities, journal.basePriorities));
  }
  return true;
}
