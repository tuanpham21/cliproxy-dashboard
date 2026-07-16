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
    lifecycle: rotationLifecycleForMode(mode),
    pool: [],
    eligibleCount: 0,
    provisionalCount: 0,
    switchTimestamps: [],
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
    return isRotationState(parsed)
      ? { state: parsed, missing: false }
      : { state: corruptRotationState("rotation state schema is invalid"), missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: defaultRotationState(mode), missing: true };
    return { state: corruptRotationState("rotation state is unreadable"), missing: false };
  }
}
