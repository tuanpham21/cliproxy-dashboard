import type { CodexLoginProfileRegistry } from "./codex-login-profile-registry.js";
import {
  CodexProfileLifecycleFenceError,
  type CodexProfileLifecycleFence,
} from "./codex-profile-lifecycle-fence.js";
import type { CodexProfileLifecycleStore } from "./codex-profile-lifecycle-store.js";
import type { CodexProfileObservationStore } from "./codex-profile-observation-store.js";
import type { CodexRedemptionDeletionDisposition } from "./codex-redemption-private-state.js";

type RegistryLike = Pick<CodexLoginProfileRegistry, "delete" | "get" | "list" | "updateMetadata">;
type ObservationStoreLike = Pick<CodexProfileObservationStore, "remove">;
type LifecycleStoreLike = Pick<
  CodexProfileLifecycleStore,
  "clearCleanupRequired" | "getCleanupRequired" | "markCleanupRequired"
>;
type RedemptionLifecycleLike = {
  deletionDisposition(profileId: string): Promise<CodexRedemptionDeletionDisposition>;
};

type CodexProfileLifecycleServiceDependencies = {
  registry: RegistryLike;
  observationStore: ObservationStoreLike;
  lifecycleStore: LifecycleStoreLike;
  lifecycleFence: CodexProfileLifecycleFence;
  redemptionService: RedemptionLifecycleLike;
};

export type DeleteCodexProfileInput = { confirmed: true };
export type DeletedCodexProfileView = { profileId: string; status: "deleted" };

export class CodexProfileLifecycleServiceError extends Error {
  constructor(readonly code: "invalid-confirmation" | "profile-not-deletable" | "profile-busy" |
    "redemption-active" | "redemption-state-unavailable" | "cleanup-required" | "unavailable") {
    super("Codex Login Profile lifecycle action unavailable.");
    this.name = "CodexProfileLifecycleServiceError";
  }
}

export class CodexProfileLifecycleService {
  constructor(private readonly dependencies: CodexProfileLifecycleServiceDependencies) {}

  async deleteProfile(profileId: string, input: DeleteCodexProfileInput): Promise<DeletedCodexProfileView> {
    if (!input || input.confirmed !== true || Object.keys(input).join(",") !== "confirmed") {
      throw new CodexProfileLifecycleServiceError("invalid-confirmation");
    }
    let lease;
    try {
      lease = await this.dependencies.lifecycleFence.acquire(profileId, "delete");
    } catch (error) {
      if (error instanceof CodexProfileLifecycleFenceError) {
        throw new CodexProfileLifecycleServiceError(error.code === "profile-busy" ? "profile-busy" : "unavailable");
      }
      throw new CodexProfileLifecycleServiceError("unavailable");
    }
    let released = false;
    let cleanupReserved = false;
    try {
      const existing = await this.dependencies.lifecycleStore.getCleanupRequired(profileId);
      if (!existing) {
        let profile;
        try {
          profile = await this.dependencies.registry.get(profileId);
        } catch {
          throw new CodexProfileLifecycleServiceError("profile-not-deletable");
        }
        if (profile.status !== "confirmed") throw new CodexProfileLifecycleServiceError("profile-not-deletable");
        const disposition = await this.dependencies.redemptionService.deletionDisposition(profileId);
        if (disposition === "blocked") throw new CodexProfileLifecycleServiceError("redemption-active");
        if (disposition !== "safe") throw new CodexProfileLifecycleServiceError("redemption-state-unavailable");
        try {
          await this.dependencies.lifecycleStore.markCleanupRequired({
            profileId: profile.id,
            label: profile.label,
            order: profile.order,
          });
          cleanupReserved = true;
        } catch {
          throw new CodexProfileLifecycleServiceError("unavailable");
        }
      } else {
        cleanupReserved = true;
      }

      try {
        const current = (await this.dependencies.registry.list()).find((profile) => profile.id === profileId);
        if (current) {
          if (current.status !== "confirmed") throw new Error("profile not confirmed");
          if (current.enabled) await this.dependencies.registry.updateMetadata(profileId, { enabled: false });
        }
        await this.dependencies.observationStore.remove(profileId);
        await this.dependencies.registry.delete(profileId);
      } catch {
        throw new CodexProfileLifecycleServiceError("cleanup-required");
      }

      try {
        await lease.release();
        released = true;
        await this.dependencies.lifecycleStore.clearCleanupRequired(profileId);
      } catch {
        throw new CodexProfileLifecycleServiceError("cleanup-required");
      }
      return { profileId, status: "deleted" };
    } catch (error) {
      if (error instanceof CodexProfileLifecycleServiceError) throw error;
      throw new CodexProfileLifecycleServiceError(cleanupReserved ? "cleanup-required" : "unavailable");
    } finally {
      if (!released) await lease.release().catch(() => {});
    }
  }
}
