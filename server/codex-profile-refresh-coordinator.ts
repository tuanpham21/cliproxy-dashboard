import type { CodexProfileObservationRowView } from "../shared/codex-profile-observation-types.js";
import type {
  CodexProfileRefreshEntryView,
  CodexProfileRefreshRunView,
  CodexProfileRefreshSource,
} from "../shared/codex-profile-refresh-types.js";
import {
  CodexProfileObservationServiceError,
  type CodexProfileObservationService,
} from "./codex-profile-observation-service.js";
import { CODEX_PROFILE_REFRESH_INTERVAL_MS } from "./codex-profile-refresh-policy.js";

type ObservationServiceLike = Pick<CodexProfileObservationService, "cancelRefresh" | "list" | "refresh">;

type CodexProfileRefreshCoordinatorDependencies = {
  observationService: ObservationServiceLike;
  backoff?: () => Promise<void>;
  now?: () => Date;
  schedule?: (task: () => Promise<CodexProfileRefreshRunView>, intervalMs: number) => unknown;
  clearSchedule?: (handle: unknown) => void;
};

const idleState = (): CodexProfileRefreshRunView => ({
  source: null,
  outcome: "idle",
  startedAt: null,
  finishedAt: null,
  total: 0,
  completed: 0,
  currentProfileId: null,
  profiles: [],
});

export class CodexProfileRefreshCoordinator {
  private readonly observationService: ObservationServiceLike;
  private readonly backoff: () => Promise<void>;
  private readonly now: () => Date;
  private readonly schedule: NonNullable<CodexProfileRefreshCoordinatorDependencies["schedule"]>;
  private readonly clearSchedule: NonNullable<CodexProfileRefreshCoordinatorDependencies["clearSchedule"]>;
  private current = idleState();
  private active: Promise<CodexProfileRefreshRunView> | null = null;
  private cancellationRequested = false;
  private scheduleHandle: unknown = null;

  constructor(dependencies: CodexProfileRefreshCoordinatorDependencies) {
    this.observationService = dependencies.observationService;
    this.backoff = dependencies.backoff ?? (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    });
    this.now = dependencies.now ?? (() => new Date());
    this.schedule = dependencies.schedule ?? ((task, intervalMs) => setInterval(task, intervalMs));
    this.clearSchedule = dependencies.clearSchedule ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  start(): Promise<CodexProfileRefreshRunView> {
    if (this.scheduleHandle === null) {
      this.scheduleHandle = this.schedule(
        async () => await this.refreshAll("scheduled"),
        CODEX_PROFILE_REFRESH_INTERVAL_MS,
      );
    }
    return this.refreshAll("startup");
  }

  async close(): Promise<void> {
    if (this.scheduleHandle !== null) {
      this.clearSchedule(this.scheduleHandle);
      this.scheduleHandle = null;
    }
    await this.cancel();
  }

  refreshAll(source: CodexProfileRefreshSource): Promise<CodexProfileRefreshRunView> {
    if (this.active) return this.active;
    this.current = {
      ...idleState(),
      source,
      outcome: "running",
      startedAt: this.now().toISOString(),
    };
    this.cancellationRequested = false;
    const task = this.performRefreshAll().catch(() => {
      this.current.currentProfileId = null;
      this.current.finishedAt = this.now().toISOString();
      this.current.outcome = this.cancellationRequested ? "cancelled" : "partial";
      return this.status();
    }).finally(() => {
      if (this.active === task) this.active = null;
    });
    this.active = task;
    return task;
  }

  status(): CodexProfileRefreshRunView {
    return structuredClone(this.current);
  }

  async cancel(): Promise<CodexProfileRefreshRunView> {
    if (!this.active) return this.status();
    this.cancellationRequested = true;
    if (this.current.currentProfileId) {
      await this.observationService.cancelRefresh(this.current.currentProfileId);
    }
    return await this.active;
  }

  private async performRefreshAll(): Promise<CodexProfileRefreshRunView> {
    const list = await this.observationService.list();
    this.current.total = list.profiles.length;
    this.current.profiles = list.profiles.map((profile) => ({
      profileId: profile.profileId,
      label: profile.label,
      status: "pending",
      attempts: 0,
    }));
    for (const [index, profile] of list.profiles.entries()) {
      if (this.cancellationRequested) {
        this.cancelRemaining(index);
        break;
      }
      await this.refreshProfile(profile, this.current.profiles[index]!);
      this.current.completed += 1;
      if (this.cancellationRequested) {
        this.cancelRemaining(index + 1);
        break;
      }
    }
    this.current.currentProfileId = null;
    this.current.finishedAt = this.now().toISOString();
    this.current.outcome = this.cancellationRequested
      ? "cancelled"
      : this.current.profiles.some((profile) => profile.status === "failed")
        ? "partial"
        : "completed";
    return this.status();
  }

  private async refreshProfile(
    profile: CodexProfileObservationRowView,
    entry: CodexProfileRefreshEntryView,
  ): Promise<void> {
    if (!profile.enabled || profile.status === "re-login-required" || profile.status === "identity-changed" ||
      profile.status === "pending") {
      entry.status = "skipped";
      entry.reason = profile.status === "re-login-required"
        ? "re-login-required"
        : profile.status === "identity-changed"
          ? "identity-changed"
          : profile.status === "pending"
            ? "not-refreshable"
            : "disabled";
      return;
    }
    this.current.currentProfileId = profile.profileId;
    entry.status = "refreshing";
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      entry.attempts = attempt;
      try {
        await this.observationService.refresh(profile.profileId);
        entry.status = "refreshed";
        return;
      } catch (error) {
        if (error instanceof CodexProfileObservationServiceError && error.code === "cancelled") {
          entry.status = "cancelled";
          entry.reason = "cancelled";
          return;
        }
        if (attempt === 1 && error instanceof CodexProfileObservationServiceError && error.code === "read-failed") {
          await this.backoff();
          continue;
        }
        entry.status = "failed";
          entry.reason = error instanceof CodexProfileObservationServiceError && error.code === "authentication-required"
            ? "re-login-required"
            : error instanceof CodexProfileObservationServiceError && error.code === "identity-changed"
              ? "identity-changed"
              : error instanceof CodexProfileObservationServiceError && error.code === "profile-not-refreshable"
                ? "not-refreshable"
                : "read-failed";
        return;
      }
    }
  }

  private cancelRemaining(startIndex: number): void {
    for (const entry of this.current.profiles.slice(startIndex)) {
      if (entry.status !== "pending") continue;
      entry.status = "cancelled";
      entry.reason = "cancelled";
    }
  }
}
