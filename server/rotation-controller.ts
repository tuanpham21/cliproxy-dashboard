import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { atomicWriteText } from "./files.js";
import {
  acquireRotationStateOwnership,
  releaseRotationStateOwnership,
  type RotationStateOwnership,
} from "./rotation-state-ownership.js";
import { isRotationState, MAX_ROTATION_PRIORITY } from "./rotation-state-codec.js";
import type {
  RotationControllerOptions,
  RotationJournal,
  RotationPauseReason,
  RotationPrioritySnapshot,
  RotationPrioritySnapshots,
  RotationPriorityWriter,
  RotationState,
} from "./rotation-types.js";

type ManagedProxyAccount = Awaited<ReturnType<RotationPriorityWriter["readAccounts"]>>[number];

export type PendingRotationRequest = {
  observationId: string;
  evidenceWatermark: string;
  fromProxyAccountKey?: string;
  routingTargetKey: string;
  targetFingerprint: string;
};

export type PendingRotationConfirmation = {
  observationId: string;
  observedRoutedAccountKey: string;
  observedFingerprint: string;
  evidenceWatermark: string;
};

function emptyJournal(): RotationJournal {
  return { phase: "idle" };
}

function lifecycleForMode(mode: RotationState["mode"]): RotationState["lifecycle"] {
  return mode === "off" ? "off" : mode;
}

function defaultState(mode: RotationState["mode"]): RotationState {
  return {
    schemaVersion: 1,
    mode,
    lifecycle: lifecycleForMode(mode),
    pool: [],
    switchTimestamps: [],
    journal: emptyJournal(),
    manualHold: false,
    restorationVerified: true,
    audit: [],
  };
}

function corruptState(message: string): RotationState {
  return {
    ...defaultState("off"),
    lifecycle: "paused",
    pauseReason: "corrupt-state",
    pauseMessage: message,
    restorationVerified: false,
  };
}

function cloneState(state: RotationState): RotationState {
  return structuredClone(state);
}

function proxyAccountMap(proxyAccounts: ManagedProxyAccount[]): Map<string, ManagedProxyAccount> {
  return new Map(proxyAccounts.map((proxyAccount) => [proxyAccount.proxyAccountKey, proxyAccount]));
}

function snapshot(proxyAccount: ManagedProxyAccount): RotationPrioritySnapshot {
  return {
    fileName: proxyAccount.fileName,
    present: proxyAccount.explicitPriority,
    ...(proxyAccount.explicitPriority ? { value: proxyAccount.priority } : {}),
    fingerprint: proxyAccount.fingerprint,
    disabled: proxyAccount.disabled,
    note: proxyAccount.note,
  };
}

function snapshots(proxyAccounts: ManagedProxyAccount[]): RotationPrioritySnapshots {
  return Object.fromEntries(proxyAccounts.map((proxyAccount) => [proxyAccount.proxyAccountKey, snapshot(proxyAccount)]));
}

function priorityMatches(proxyAccount: ManagedProxyAccount, expected: RotationPrioritySnapshot): boolean {
  return proxyAccount.explicitPriority === expected.present && proxyAccount.priority === (expected.value ?? 0);
}

function metadataMatches(proxyAccount: ManagedProxyAccount, expected: RotationPrioritySnapshot): boolean {
  return proxyAccount.fileName === expected.fileName && proxyAccount.fingerprint === expected.fingerprint && proxyAccount.disabled === expected.disabled && proxyAccount.note === expected.note;
}

function validPriority(proxyAccount: ManagedProxyAccount): boolean {
  return Number.isSafeInteger(proxyAccount.priority) && proxyAccount.priority >= 0 && proxyAccount.priority <= MAX_ROTATION_PRIORITY;
}

function snapshotConflict(
  current: Map<string, ManagedProxyAccount>,
  expected: RotationPrioritySnapshots,
  context: "rollback" | "restoration",
  allowedPriority: (proxyAccountKey: string) => number | undefined,
): { reason: RotationPauseReason; message: string } | null {
  for (const [proxyAccountKey, baseline] of Object.entries(expected)) {
    const proxyAccount = current.get(proxyAccountKey);
    if (!proxyAccount) return { reason: "recovery-unverifiable", message: `Proxy Account deleted during ${context}: ${proxyAccountKey}` };
    if (!metadataMatches(proxyAccount, baseline)) return { reason: "identity-mismatch", message: `Proxy Account changed during ${context}: ${proxyAccountKey}` };
    const overlayPriority = allowedPriority(proxyAccountKey);
    const matchesOverlay = overlayPriority !== undefined && proxyAccount.explicitPriority && proxyAccount.priority === overlayPriority;
    if (!priorityMatches(proxyAccount, baseline) && !matchesOverlay) {
      return { reason: "external-priority-edit", message: `external priority edit during ${context}: ${proxyAccountKey}` };
    }
  }
  return null;
}

async function readInitialState(statePath: string, mode: RotationState["mode"]): Promise<{ state: RotationState; missing: boolean }> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as unknown;
    return isRotationState(parsed) ? { state: parsed, missing: false } : { state: corruptState("rotation state schema is invalid"), missing: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: defaultState(mode), missing: true };
    return { state: corruptState("rotation state is unreadable"), missing: false };
  }
}

export class RotationController {
  readonly #statePath: string;
  readonly #writer?: RotationPriorityWriter;
  readonly #now: () => number;
  readonly #crashInjector?: RotationControllerOptions["crashInjector"];
    readonly #ownership: RotationStateOwnership;
    #state: RotationState;
    #closed = false;
    #closing?: Promise<void>;
    #lock: Promise<void> = Promise.resolve();

  constructor(statePath: string, state: RotationState, options: RotationControllerOptions, ownership: RotationStateOwnership) {
    this.#statePath = statePath;
    this.#state = state;
    this.#writer = options.writer;
    this.#now = options.now ?? Date.now;
    this.#crashInjector = options.crashInjector;
    this.#ownership = ownership;
  }

  state(): RotationState {
    return cloneState(this.#state);
  }

    close(): Promise<void> {
      if (!this.#closing) {
        this.#closed = true;
        this.#closing = this.#lock.then(() => { releaseRotationStateOwnership(this.#ownership); });
      }
      return this.#closing;
  }

  async beginPendingRotation(request: PendingRotationRequest): Promise<RotationState> {
    return await this.#withLock(async () => {
      if (this.#state.lifecycle === "paused" || this.#state.lifecycle === "recovery-required") return this.state();
      if (this.#state.mode === "off") return await this.#pause("observation-uncertain", "rotation controller is off");
      if (!this.#writer) return await this.#pause("mutation-failed", "CLIProxy priority writer unavailable");
      if (this.#state.journal.phase !== "idle") return await this.#pause("recovery-unverifiable", "Pending Rotation already active");

      const proxyAccounts = await this.#writer.readAccounts();
      const currentByKey = proxyAccountMap(proxyAccounts);
      const overlayError = this.#validateOverlay(proxyAccounts);
      if (overlayError) return await this.#pause(overlayError.reason, overlayError.message);
      const target = currentByKey.get(request.routingTargetKey);
      if (!target) return await this.#pause("selection-mismatch", "Routing Target is missing");
      if (target.fingerprint !== request.targetFingerprint) return await this.#pause("identity-mismatch", "Routing Target identity changed");
      if (target.disabled) return await this.#pause("selection-mismatch", "Routing Target is disabled");
      if (proxyAccounts.some((proxyAccount) => !validPriority(proxyAccount))) return await this.#pause("external-priority-edit", "unsafe external priority value");
      const maximum = Math.max(0, ...proxyAccounts.map((proxyAccount) => proxyAccount.priority));
      if (maximum >= MAX_ROTATION_PRIORITY) return await this.#pause("insufficient-priority-headroom", "no safe priority above current maximum");
      const intendedPriority = maximum + 1;
      const previousPriorities = snapshots(proxyAccounts);
      const basePriorities: RotationPrioritySnapshots = structuredClone(this.#state.overlay?.basePriorities ?? {});
      for (const [key, value] of Object.entries(previousPriorities)) {
        if (!basePriorities[key]) basePriorities[key] = value;
      }

      this.#state.lifecycle = "pending";
      this.#state.pauseReason = undefined;
      this.#state.pauseMessage = undefined;
      this.#state.restorationVerified = false;
      this.#state.journal = {
        phase: "journaled",
        observationId: request.observationId,
        fromProxyAccountKey: request.fromProxyAccountKey,
        routingTargetKey: request.routingTargetKey,
        targetFingerprint: request.targetFingerprint,
        evidenceWatermark: request.evidenceWatermark,
        intendedPriority,
        basePriorities,
        previousPriorities,
        updatedAt: new Date(this.#now()).toISOString(),
      };
      await this.#persist();
      await this.#inject("journaled");

      this.#state.journal.phase = "mutating";
      await this.#persist();
      await this.#inject("mutating");
      let result: Awaited<ReturnType<RotationPriorityWriter["setTargetPriority"]>>;
      try {
        result = await this.#writer.setTargetPriority({
          fileName: target.fileName,
          proxyAccountKey: target.proxyAccountKey,
          priority: intendedPriority,
          expectedRevision: target.revision,
          expectedFingerprint: request.targetFingerprint,
        });
      } catch (error) {
        return await this.#pause("mutation-failed", error instanceof Error ? error.message : String(error));
      }
      if (
        result.priority !== intendedPriority
        || !result.explicitPriority
        || !result.revision
        || result.fingerprint !== request.targetFingerprint
      ) {
        return await this.#pause(
          "mutation-verification-failed",
          "CLIProxy mutation result did not match intended target overlay",
        );
      }
      this.#state.journal.phase = "mutated";
      this.#state.journal.targetRevision = result.revision;
      await this.#persist();
      await this.#inject("mutated");

      const verification = await this.#verifyMutation(previousPriorities, request.routingTargetKey, intendedPriority, request.targetFingerprint, result.revision);
      if (verification) return await this.#pause(verification.reason, verification.message);
      this.#state.lifecycle = "awaiting-confirmation";
      this.#state.journal.phase = "verified";
      await this.#persist();
      await this.#inject("verified");
      return this.state();
    });
  }

    async confirmPendingRotation(confirmation: PendingRotationConfirmation): Promise<RotationState> {
      return await this.#withLock(async () => {
        if (this.#state.lifecycle === "paused" || this.#state.lifecycle === "recovery-required") return this.state();
        const journal = this.#state.journal;
      if (journal.phase !== "verified" || !journal.routingTargetKey || journal.intendedPriority === undefined || !journal.basePriorities || !journal.previousPriorities) {
        return await this.#pause("recovery-unverifiable", "no verified Pending Rotation to confirm");
      }
      if (confirmation.observationId !== journal.observationId || confirmation.observedRoutedAccountKey !== journal.routingTargetKey) {
        return await this.#pause("selection-mismatch", "Observed Routed Account does not confirm intended target");
      }
      if (confirmation.observedFingerprint !== journal.targetFingerprint) {
        return await this.#pause("identity-mismatch", "observed routed identity does not match intended target");
      }
      const journalWatermarkMs = Date.parse(journal.evidenceWatermark ?? "");
      const confirmationWatermarkMs = Date.parse(confirmation.evidenceWatermark);
      if (!Number.isFinite(journalWatermarkMs) || !Number.isFinite(confirmationWatermarkMs) || confirmationWatermarkMs <= journalWatermarkMs) {
        return await this.#pause("observation-uncertain", "confirmation evidence is not newer than Pending Rotation evidence");
      }
      const verification = await this.#verifyMutation(journal.previousPriorities, journal.routingTargetKey, journal.intendedPriority, journal.targetFingerprint ?? "");
      if (verification) return await this.#pause(verification.reason, verification.message);
      this.#state.overlay = {
        basePriorities: structuredClone(journal.basePriorities),
        appliedPriorities: { ...(this.#state.overlay?.appliedPriorities ?? {}), [journal.routingTargetKey]: journal.intendedPriority },
      };
      this.#state.routingTargetKey = journal.routingTargetKey;
      this.#state.observedRoutedAccountKey = confirmation.observedRoutedAccountKey;
      this.#state.lastObservationId = confirmation.observationId;
      this.#state.evidenceWatermark = confirmation.evidenceWatermark;
      this.#state.switchTimestamps.push(this.#now());
      this.#state.lifecycle = lifecycleForMode(this.#state.mode);
      this.#state.pauseReason = undefined;
      this.#state.pauseMessage = undefined;
      this.#state.journal.phase = "committed";
      await this.#persist();
      await this.#inject("committed");
      this.#state.journal = emptyJournal();
      await this.#persist();
      return this.state();
    });
  }

    async disable(): Promise<RotationState> {
      return await this.#withLock(async () => {
        if (this.#state.pauseReason === "corrupt-state") return this.state();
        if (this.#state.journal.phase !== "idle" && this.#state.journal.phase !== "committed" && this.#state.journal.phase !== "restoring") {
        const rollback = await this.#rollbackPending();
        if (rollback.lifecycle === "paused" || rollback.lifecycle === "recovery-required") return rollback;
      } else if (this.#state.journal.phase === "committed") {
        this.#state.journal = emptyJournal();
        await this.#persist();
      }
      if (this.#state.overlay) return await this.#restoreOverlay(true);
      this.#state.mode = "off";
      this.#state.lifecycle = "off";
      this.#state.restorationVerified = true;
      this.#state.journal = emptyJournal();
      this.#state.pauseReason = undefined;
      this.#state.pauseMessage = undefined;
      await this.#persist();
      return this.state();
    });
  }

  async recover(): Promise<RotationState> {
    return await this.#withLock(async () => {
      switch (this.#state.journal.phase) {
      case "idle":
        return this.state();
      case "committed":
        this.#state.journal = emptyJournal();
        await this.#persist();
        return this.state();
      case "restoring":
        return this.#state.journal.restoreIntent === "disable" ? await this.#restoreOverlay(true) : await this.#rollbackPending();
      default:
        return await this.#rollbackPending();
      }
    });
  }

  async #rollbackPending(): Promise<RotationState> {
      const previous = this.#state.journal.previousPriorities;
      if (!previous || !this.#writer) return await this.#pause("recovery-unverifiable", "rollback ledger unavailable");
      const current = proxyAccountMap(await this.#writer.readAccounts());
      const conflict = snapshotConflict(
        current,
        previous,
        "rollback",
        (proxyAccountKey) => proxyAccountKey === this.#state.journal.routingTargetKey ? this.#state.journal.intendedPriority : undefined,
      );
      if (conflict) return await this.#pause(conflict.reason, conflict.message);
      const restorationFailure = await this.#restoreAndVerify(previous, "rollback", "rollback verification failed");
      if (restorationFailure) return restorationFailure;
    this.#state.journal = emptyJournal();
    this.#state.lifecycle = lifecycleForMode(this.#state.mode);
    this.#state.restorationVerified = !this.#state.overlay;
    this.#state.pauseReason = undefined;
    this.#state.pauseMessage = undefined;
    await this.#persist();
    return this.state();
  }

  async #restoreOverlay(disable: boolean): Promise<RotationState> {
    const base = this.#state.overlay?.basePriorities ?? this.#state.journal.basePriorities;
      if (!base || !this.#writer) return await this.#pause("recovery-unverifiable", "base priority ledger unavailable");
      const overlay = this.#state.overlay;
      const current = proxyAccountMap(await this.#writer.readAccounts());
      const conflict = snapshotConflict(current, base, "restoration", (proxyAccountKey) => overlay?.appliedPriorities[proxyAccountKey]);
      if (conflict) return await this.#pause(conflict.reason, conflict.message);
      const restorationFailure = await this.#restoreAndVerify(
        base,
        disable ? "disable" : "rollback",
        "base priority restoration verification failed",
        true,
      );
      if (restorationFailure) return restorationFailure;
    this.#state.overlay = undefined;
    this.#state.journal = emptyJournal();
    this.#state.restorationVerified = true;
    this.#state.pauseReason = undefined;
    this.#state.pauseMessage = undefined;
    if (disable) {
      this.#state.mode = "off";
      this.#state.lifecycle = "off";
    } else {
      this.#state.lifecycle = lifecycleForMode(this.#state.mode);
    }
      await this.#persist();
      return this.state();
    }

    async #restoreAndVerify(
      expected: RotationPrioritySnapshots,
      restoreIntent: NonNullable<RotationJournal["restoreIntent"]>,
      verificationMessage: string,
      recordBasePriorities = false,
    ): Promise<RotationState | null> {
      this.#state.journal = {
        ...this.#state.journal,
        phase: "restoring",
        restoreIntent,
        ...(recordBasePriorities ? { basePriorities: expected } : {}),
      };
      await this.#persist();
      await this.#inject("restoring");
      await this.#restoreSnapshots(expected);
      if (!(await this.#verifySnapshots(expected))) return await this.#pause("recovery-unverifiable", verificationMessage);
      return null;
    }

    async #restoreSnapshots(expected: RotationPrioritySnapshots): Promise<void> {
    if (!this.#writer) throw new Error("CLIProxy priority writer unavailable");
    const current = proxyAccountMap(await this.#writer.readAccounts());
    const entries: Parameters<RotationPriorityWriter["restoreBasePriorities"]>[0] = {};
    for (const [key, baseline] of Object.entries(expected)) {
      const proxyAccount = current.get(key);
      if (!proxyAccount || priorityMatches(proxyAccount, baseline)) continue;
      entries[key] = {
        fileName: baseline.fileName,
        proxyAccountKey: key,
        present: baseline.present,
        ...(baseline.present ? { value: baseline.value } : {}),
        expectedRevision: proxyAccount.revision,
        expectedFingerprint: baseline.fingerprint,
      };
    }
    if (Object.keys(entries).length > 0) await this.#writer.restoreBasePriorities(entries);
  }

  async #verifySnapshots(expected: RotationPrioritySnapshots): Promise<boolean> {
    if (!this.#writer) return false;
    const current = proxyAccountMap(await this.#writer.readAccounts());
    return Object.entries(expected).every(([key, baseline]) => {
      const proxyAccount = current.get(key);
      return Boolean(proxyAccount && metadataMatches(proxyAccount, baseline) && priorityMatches(proxyAccount, baseline));
    });
  }

  async #verifyMutation(previous: RotationPrioritySnapshots, routingTargetKey: string, intendedPriority: number, fingerprint: string, revision?: string): Promise<{ reason: RotationPauseReason; message: string } | null> {
    if (!this.#writer) return { reason: "mutation-verification-failed", message: "CLIProxy priority writer unavailable" };
    const current = proxyAccountMap(await this.#writer.readAccounts());
    for (const [key, before] of Object.entries(previous)) {
      const proxyAccount = current.get(key);
      if (!proxyAccount) return { reason: "mutation-verification-failed", message: `Proxy Account deleted during mutation: ${key}` };
      if (!metadataMatches(proxyAccount, before)) return { reason: "identity-mismatch", message: `Proxy Account changed during mutation: ${key}` };
      if (key === routingTargetKey) {
        if (!proxyAccount.explicitPriority || proxyAccount.priority !== intendedPriority || proxyAccount.fingerprint !== fingerprint || (revision !== undefined && proxyAccount.revision !== revision)) {
          return { reason: "mutation-verification-failed", message: "target priority mutation verification failed" };
        }
      } else if (!priorityMatches(proxyAccount, before)) {
        return { reason: "external-priority-edit", message: `unrelated priority changed during mutation: ${key}` };
      }
    }
    return null;
  }

  #validateOverlay(proxyAccounts: ManagedProxyAccount[]): { reason: RotationPauseReason; message: string } | null {
    const overlay = this.#state.overlay;
    if (!overlay) return null;
    const current = proxyAccountMap(proxyAccounts);
    for (const [key, baseline] of Object.entries(overlay.basePriorities)) {
      const proxyAccount = current.get(key);
      if (!proxyAccount) return { reason: "selection-mismatch", message: `Proxy Account deleted under active overlay: ${key}` };
      if (!metadataMatches(proxyAccount, baseline)) return { reason: "identity-mismatch", message: `Proxy Account identity changed under active overlay: ${key}` };
      const applied = overlay.appliedPriorities[key];
      const matchesApplied = applied !== undefined && proxyAccount.explicitPriority && proxyAccount.priority === applied;
      if (!matchesApplied && !(applied === undefined && priorityMatches(proxyAccount, baseline))) {
        return { reason: "external-priority-edit", message: `external priority edit under active overlay: ${key}` };
      }
    }
    return null;
  }

  async #pause(reason: RotationPauseReason, message: string): Promise<RotationState> {
    this.#state.lifecycle = "paused";
    this.#state.pauseReason = reason;
    this.#state.pauseMessage = message;
    this.#state.audit.push({ id: randomUUID(), at: new Date(this.#now()).toISOString(), kind: "pause", message, pauseReason: reason });
    await this.#persist();
    return this.state();
  }

  async #persist(): Promise<void> {
    await mkdir(path.dirname(this.#statePath), { recursive: true });
    await atomicWriteText(this.#statePath, `${JSON.stringify(this.#state, null, 2)}\n`);
  }

  async #inject(phase: RotationJournal["phase"]): Promise<void> {
    await this.#crashInjector?.(phase);
  }

  async #withLock<T>(task: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error("rotation controller ownership is closed");
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  }
}

export async function openRotationController(options: RotationControllerOptions): Promise<RotationController> {
  const statePath = path.resolve(options.statePath);
  const ownership = await acquireRotationStateOwnership(statePath);
  try {
    const loaded = await readInitialState(statePath, options.mode ?? "off");
    const controller = new RotationController(statePath, loaded.state, options, ownership);
    if (loaded.missing) {
      await mkdir(path.dirname(statePath), { recursive: true });
      await atomicWriteText(statePath, `${JSON.stringify(loaded.state, null, 2)}\n`);
    }
    return controller;
  } catch (error) {
    releaseRotationStateOwnership(ownership);
    throw error;
  }
}
