import type { CodexRedemptionCurrentView } from "../shared/codex-account-types.js";
import {
  CodexRedemptionRecoveryCoordinator,
  type RecoveryCoordinatorDependencies,
  type RecoveryCoordinatorStore,
} from "./codex-redemption-recovery-coordinator.js";

const RECOVERY_RECHECK_MS = 5_000;

const RECOVERY_STORE_METHODS = [
  "initializeRecovery",
  "claimAmbiguousRetry",
  "releaseRetryClaim",
  "verifyRecoveryEvidence",
  "readPublicState",
  "readTombstone",
  "transitionJournal",
  "publishTombstone",
  "releaseTerminal",
] as const;

type RecoveryManagerDependencies = Omit<RecoveryCoordinatorDependencies, "store"> & {
  store: unknown;
  schedule: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearScheduled: (timer: NodeJS.Timeout) => void;
};

function isRecoveryCoordinatorStore(store: unknown): store is RecoveryCoordinatorStore {
  if (typeof store !== "object" || store === null) return false;
  const candidate = store as Record<string, unknown>;
  return RECOVERY_STORE_METHODS.every((method) => typeof candidate[method] === "function");
}

export class CodexRedemptionRecoveryManager {
  private readonly coordinator: CodexRedemptionRecoveryCoordinator;
  private timer: NodeJS.Timeout | null = null;
  private recoveryRequired = false;
  private generation = 0;

  private constructor(private readonly dependencies: RecoveryManagerDependencies & { store: RecoveryCoordinatorStore }) {
    this.coordinator = new CodexRedemptionRecoveryCoordinator(dependencies);
  }

  static create(dependencies: RecoveryManagerDependencies): CodexRedemptionRecoveryManager | null {
    return isRecoveryCoordinatorStore(dependencies.store)
      ? new CodexRedemptionRecoveryManager({ ...dependencies, store: dependencies.store })
      : null;
  }

  async initialize(codexBin: string): Promise<void> {
    const generation = ++this.generation;
    if (this.timer) this.dependencies.clearScheduled(this.timer);
    this.timer = null;
    let state;
    try {
      state = await this.coordinator.initialize(codexBin);
    } catch (error) {
      if (generation === this.generation) {
        this.recoveryRequired = true;
        this.scheduleRecheck(codexBin, RECOVERY_RECHECK_MS, generation);
      }
      throw error;
    }
    if (generation !== this.generation) return;
    this.recoveryRequired = state.status === "recovery-required";
    if (state.status === "processing" || state.status === "retry-finalizing" || state.status === "recovery-required") {
      this.scheduleRecheck(codexBin, RECOVERY_RECHECK_MS, generation);
      return;
    }
    if (state.status !== "prepared") return;
    const delayMs = Math.max(RECOVERY_RECHECK_MS, Date.parse(state.journal.expiresAt) - this.dependencies.now().getTime());
    this.scheduleRecheck(codexBin, delayMs, generation);
  }

  private scheduleRecheck(codexBin: string, delayMs: number, generation: number): void {
    if (this.timer) this.dependencies.clearScheduled(this.timer);
    this.timer = this.dependencies.schedule(() => {
      if (generation !== this.generation) return;
      this.timer = null;
      void this.initialize(codexBin).catch(() => {});
    }, delayMs);
  }

  isRecoveryRequired(): boolean {
    return this.recoveryRequired;
  }

  async retry(proposalId: string, codexBin: string): Promise<CodexRedemptionCurrentView> {
    return await this.coordinator.retry(proposalId, codexBin);
  }

  close(): void {
    this.generation += 1;
    if (this.timer) this.dependencies.clearScheduled(this.timer);
    this.timer = null;
  }
}
