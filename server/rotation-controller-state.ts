import { readFile } from "node:fs/promises";

import { isRotationState } from "./rotation-state-codec.js";
import type { RotationJournal, RotationState } from "./rotation-types.js";

export function emptyRotationJournal(): RotationJournal {
  return { phase: "idle" };
}

export function rotationLifecycleForMode(mode: RotationState["mode"]): RotationState["lifecycle"] {
  return mode === "off" ? "off" : mode;
}

function defaultRotationState(mode: RotationState["mode"]): RotationState {
  return {
    schemaVersion: 1,
    mode,
    poolMode: "manual",
    lifecycle: rotationLifecycleForMode(mode),
    pool: [],
    eligibleCount: 0,
      provisionalCount: 0,
      switchTimestamps: [],
      lastSelectedAtByProxyAccountKey: {},
      evidenceWatermarkObservationIds: [],
    journal: emptyRotationJournal(),
    manualHold: false,
    restorationVerified: true,
    audit: [],
  };
}

function corruptRotationState(message: string): RotationState {
  return {
    ...defaultRotationState("off"),
    lifecycle: "paused",
    pauseReason: "corrupt-state",
    pauseMessage: message,
    restorationVerified: false,
  };
}

export function cloneRotationState(state: RotationState): RotationState {
  return structuredClone(state);
}

export async function readInitialRotationState(
  statePath: string,
  mode: RotationState["mode"],
): Promise<{ state: RotationState; missing: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    const migrated = migrateRotationState(parsed);
    return isRotationState(migrated)
      ? { state: migrated, missing: false }
      : { state: corruptRotationState("rotation state schema is invalid"), missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: defaultRotationState(mode), missing: true };
    return { state: corruptRotationState("rotation state is unreadable"), missing: false };
  }
}

function migrateRotationState(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let result = { ...record };
  if (result.schemaVersion === 1 && result.poolMode === undefined) {
    result.poolMode = "manual";
  }
  if (result.poolMode === "all-enabled-codex") {
    result = {
      ...result,
      poolMode: "manual",
      mode: "off",
      lifecycle: "paused",
      pauseReason: "no-eligible-members",
      pauseMessage: "Legacy all-enabled-codex pool mode is no longer supported. Rotation pool migrated to manual.",
    };
  }
  return result;
}
