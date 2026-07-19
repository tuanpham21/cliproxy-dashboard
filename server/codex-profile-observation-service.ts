import type {
  CodexProfileObservationListView,
  CodexProfileObservationFreshness,
  CodexProfileObservationRowView,
  CodexProfileObservationSnapshot,
  CodexProfileRowStatus,
  UpdateCodexProfileMetadataInput,
} from "../shared/codex-profile-observation-types.js";
import { summarizeCodexProfileObservations } from "../shared/codex-profile-observation-types.js";
import { normalizeCodexAvailableCount, normalizeCodexUsageWindow } from "./codex-account-normalization.js";
import { CodexAccountGatewayError } from "./codex-account-gateway.js";
import type { CodexLoginProfileRecord, CodexLoginProfileRegistry } from "./codex-login-profile-registry.js";
import {
  CodexMultiProfileReadGateway,
  type CodexMultiProfileReadGatewayLike,
  type CodexMultiProfileReadGatewayStartOptions,
} from "./codex-multi-profile-read-gateway.js";
import {
  CodexProfileObservationStoreError,
  type CodexProfileObservationStore,
  type ListedCodexProfileObservation,
} from "./codex-profile-observation-store.js";
import { runtimeContextFromIdentity } from "./codex-runtime-context.js";
import type {
  CodexRuntimeIdentity,
  CodexRuntimeQualifierLike,
} from "./codex-runtime-qualifier.js";
import { CODEX_PROFILE_STALE_AFTER_MS } from "./codex-profile-refresh-policy.js";

type CodexProfileObservationRegistryLike = Pick<
  CodexLoginProfileRegistry,
  "get" | "list" | "reorder" | "updateMetadata"
>;
type CodexProfileObservationStoreLike = Pick<
  CodexProfileObservationStore,
  "get" | "isReLoginRequired" | "list" | "markReLoginRequired" | "reconcile" | "replace" | "remove"
>;
type StartReadGateway = (
  input: Pick<CodexMultiProfileReadGatewayStartOptions, "codexBin" | "runtimeContext" | "qualifier">,
) => Promise<CodexMultiProfileReadGatewayLike>;
type ActiveReadGateway = { gateway: CodexMultiProfileReadGatewayLike; closePromise: Promise<void> | null };

function isRefreshQuarantined(freshness: CodexProfileObservationFreshness | undefined): boolean {
  return freshness === "identity-changed" || freshness === "re-login-required";
}

type CodexProfileObservationServiceDependencies = {
  registry: CodexProfileObservationRegistryLike;
  observationStore: CodexProfileObservationStoreLike;
  codexBin: string;
  qualifier: CodexRuntimeQualifierLike;
  startReadGateway?: StartReadGateway;
  now?: () => Date;
};

export class CodexProfileObservationServiceError extends Error {
  constructor(readonly code: "profile-not-refreshable" | "identity-changed" | "authentication-required" | "cancelled" | "read-failed" | "unavailable") {
    super("Codex Profile Observation unavailable.");
    this.name = "CodexProfileObservationServiceError";
  }
}

export class CodexProfileObservationService {
  private readonly registry: CodexProfileObservationRegistryLike;
  private readonly observationStore: CodexProfileObservationStoreLike;
  private readonly codexBin: string;
  private readonly qualifier: CodexRuntimeQualifierLike;
  private readonly startReadGateway: StartReadGateway;
  private readonly now: () => Date;
  private readonly refreshes = new Map<string, Promise<CodexProfileObservationRowView>>();
  private readonly profileOperations = new Map<string, Promise<void>>();
  private readonly activeReadGateways = new Map<string, ActiveReadGateway>();
  private readonly cancellationRequests = new Set<string>();

  constructor(dependencies: CodexProfileObservationServiceDependencies) {
    this.registry = dependencies.registry;
    this.observationStore = dependencies.observationStore;
    this.codexBin = dependencies.codexBin;
    this.qualifier = dependencies.qualifier;
    this.startReadGateway = dependencies.startReadGateway ?? (async (input) =>
      await CodexMultiProfileReadGateway.start(input));
    this.now = dependencies.now ?? (() => new Date());
  }

  async list(): Promise<CodexProfileObservationListView> {
    try {
      const profiles = await this.registry.list();
      await this.observationStore.reconcile(profiles.map((profile) => profile.id));
        const observations = await this.observationStore.list(profiles.map((profile) => profile.id));
        const byId = new Map(observations.map((observation) => [observation.profileId, observation]));
        const reLoginRequired = new Set((await Promise.all(profiles.map(async (profile) =>
          await this.observationStore.isReLoginRequired(profile.id) ? profile.id : null)))
          .filter((profileId): profileId is string => profileId !== null));
        const repairedProfiles = await Promise.all(profiles.map(async (profile) => {
          if (profile.enabled && (reLoginRequired.has(profile.id) ||
            isRefreshQuarantined(byId.get(profile.id)?.snapshot.freshness))) {
            return await this.registry.updateMetadata(profile.id, { enabled: false });
          }
          return profile;
        }));
        const rows = repairedProfiles.map((profile) =>
          this.rowFor(profile, byId.get(profile.id), reLoginRequired.has(profile.id)));
      return { profiles: rows, summary: summarizeCodexProfileObservations(rows) };
    } catch (error) {
      if (error instanceof CodexProfileObservationServiceError) throw error;
      throw new CodexProfileObservationServiceError("unavailable");
    }
  }

  async updateMetadata(
    profileId: string,
    input: UpdateCodexProfileMetadataInput,
  ): Promise<CodexProfileObservationRowView> {
    return await this.withProfileOperation(profileId, async () => {
        try {
          const stored = await this.observationStore.get(profileId);
          const reLoginRequired = await this.observationStore.isReLoginRequired(profileId);
          if (input.enabled === true && (reLoginRequired || isRefreshQuarantined(stored?.snapshot.freshness))) {
            throw new CodexProfileObservationServiceError("profile-not-refreshable");
          }
          const profile = await this.registry.updateMetadata(profileId, input);
          return this.rowFor(profile, stored ? { profileId: profile.id, ...stored } : undefined, reLoginRequired);
      } catch (error) {
        if (error instanceof CodexProfileObservationServiceError) throw error;
        throw new CodexProfileObservationServiceError("unavailable");
      }
    });
  }

  async reorder(profileIds: readonly string[]): Promise<CodexProfileObservationListView> {
    try {
      await this.registry.reorder(profileIds);
      return await this.list();
    } catch (error) {
      if (error instanceof CodexProfileObservationServiceError) throw error;
      throw new CodexProfileObservationServiceError("unavailable");
    }
  }

  refresh(profileId: string): Promise<CodexProfileObservationRowView> {
    const existing = this.refreshes.get(profileId);
    if (existing) return existing;
    const task = this.withProfileOperation(profileId, async () => await this.performRefresh(profileId)).finally(() => {
      if (this.refreshes.get(profileId) === task) this.refreshes.delete(profileId);
      this.activeReadGateways.delete(profileId);
      this.cancellationRequests.delete(profileId);
    });
    this.refreshes.set(profileId, task);
    return task;
  }

  async cancelRefresh(profileId: string): Promise<void> {
    this.cancellationRequests.add(profileId);
    const active = this.activeReadGateways.get(profileId);
    if (active) await this.closeReadGateway(active).catch(() => {});
  }

  private async performRefresh(profileId: string): Promise<CodexProfileObservationRowView> {
    let gateway: CodexMultiProfileReadGatewayLike | null = null;
    let operationError: unknown;
    let account: { email: string; plan: string } | null = null;
    let rateLimits: Awaited<ReturnType<CodexMultiProfileReadGatewayLike["readRateLimits"]>> | null = null;
    let identity: CodexRuntimeIdentity | null = null;
    let profile: CodexLoginProfileRecord | null = null;
    let current: Awaited<ReturnType<CodexProfileObservationStoreLike["get"]>> = null;
    let closeError: unknown;
    try {
      profile = await this.registry.get(profileId);
      if (profile.status !== "confirmed") {
        throw new CodexProfileObservationServiceError("profile-not-refreshable");
      }
      current = await this.observationStore.get(profile.id);
      if (current?.snapshot.freshness === "identity-changed") {
        if (profile.enabled) profile = await this.registry.updateMetadata(profile.id, { enabled: false });
        throw new CodexProfileObservationServiceError("identity-changed");
      }
      if (!profile.enabled) throw new CodexProfileObservationServiceError("profile-not-refreshable");
      const qualification = await this.qualifier.qualify(this.codexBin, profile.runtimeContext);
      if (qualification.status !== "qualified" || !(await this.qualifier.matchesIdentity(qualification.identity))) {
        throw new CodexProfileObservationServiceError("read-failed");
      }
      identity = qualification.identity;
      if (this.cancellationRequests.has(profile.id)) {
        throw new CodexProfileObservationServiceError("cancelled");
      }
      gateway = await this.startReadGateway({
        codexBin: identity.canonicalPath,
        runtimeContext: runtimeContextFromIdentity(identity),
        qualifier: this.qualifier,
      });
      const active = { gateway, closePromise: null };
      this.activeReadGateways.set(profile.id, active);
      if (this.cancellationRequests.has(profile.id)) {
        throw new CodexProfileObservationServiceError("cancelled");
      }
      const accountRead = await gateway.readAccount();
      if (accountRead.account?.type !== "chatgpt" || !accountRead.account.email?.trim() ||
        accountRead.account.plan === "unknown") {
        throw new CodexProfileObservationServiceError("read-failed");
      }
      account = { email: accountRead.account.email.trim(), plan: accountRead.account.plan };
      if (current && (current.snapshot.account.email !== account.email || current.snapshot.account.plan !== account.plan)) {
        throw new CodexProfileObservationServiceError("identity-changed");
      }
      rateLimits = await gateway.readRateLimits();
    } catch (error) {
      operationError = error instanceof CodexAccountGatewayError && error.code === "authentication-required"
        ? new CodexProfileObservationServiceError("authentication-required")
        : error;
    }
    try {
      const active = profile ? this.activeReadGateways.get(profile.id) : undefined;
      if (active) await this.closeReadGateway(active);
      else await gateway?.close();
    } catch (error) {
      closeError = error;
    }
    if (profile && this.cancellationRequests.has(profile.id)) {
      throw new CodexProfileObservationServiceError("cancelled");
    }
    if (operationError instanceof CodexProfileObservationServiceError && operationError.code === "identity-changed" &&
        profile && current && current.snapshot.freshness !== "identity-changed") {
      try {
        await this.observationStore.replace(profile.id, current.generation, {
          ...current.snapshot,
          freshness: "identity-changed",
        });
        await this.registry.updateMetadata(profile.id, { enabled: false });
      } catch {
        throw new CodexProfileObservationServiceError("unavailable");
      }
      if (closeError) throw new CodexProfileObservationServiceError("read-failed");
      throw operationError;
    }
      if (operationError instanceof CodexProfileObservationServiceError && operationError.code === "authentication-required" &&
        profile) {
        try {
          await this.observationStore.markReLoginRequired(profile.id);
          if (current) {
            await this.observationStore.replace(profile.id, current.generation, {
              ...current.snapshot,
              freshness: "re-login-required",
            });
          }
          await this.registry.updateMetadata(profile.id, { enabled: false });
      } catch {
        throw new CodexProfileObservationServiceError("unavailable");
      }
      throw operationError;
    }
    const expectedFailure = operationError instanceof CodexProfileObservationServiceError &&
      ["profile-not-refreshable", "identity-changed", "authentication-required", "cancelled"].includes(operationError.code);
    if (profile && current && (closeError || (operationError && !expectedFailure))) {
      try {
        await this.observationStore.replace(profile.id, current.generation, {
          ...current.snapshot,
          freshness: "stale",
        });
      } catch {
        throw new CodexProfileObservationServiceError("unavailable");
      }
    }
    if (closeError) throw new CodexProfileObservationServiceError("read-failed");
    if (operationError) {
      if (operationError instanceof CodexProfileObservationServiceError) throw operationError;
      throw new CodexProfileObservationServiceError("read-failed");
    }
    if (!account || !rateLimits || !identity || !profile) {
      throw new CodexProfileObservationServiceError("read-failed");
    }
    const snapshot: CodexProfileObservationSnapshot = {
      account,
      observedAt: this.now().toISOString(),
      usage: {
        primary: normalizeCodexUsageWindow(rateLimits.rateLimits.primary),
        secondary: normalizeCodexUsageWindow(rateLimits.rateLimits.secondary),
      },
      resetCredits: { availableCount: normalizeCodexAvailableCount(rateLimits.resetCredits?.availableCount) },
      runtimeVersion: identity.version,
      freshness: "fresh",
    };
    try {
      const stored = await this.observationStore.replace(profile.id, current?.generation ?? null, snapshot);
        return this.rowFor(profile, { profileId: profile.id, ...stored }, false);
    } catch (error) {
      if (error instanceof CodexProfileObservationStoreError && error.code === "stale-generation") {
        const latest = (await this.list()).profiles.find((row) => row.profileId === profile.id);
        if (latest) return latest;
      }
      throw new CodexProfileObservationServiceError("unavailable");
    }
  }

    private rowFor(
      profile: CodexLoginProfileRecord,
      stored: ListedCodexProfileObservation | undefined,
      reLoginRequired: boolean,
    ): CodexProfileObservationRowView {
    const retained = profile.status === "confirmed" ? stored?.snapshot ?? null : null;
    const observation = retained ? { ...retained, freshness: this.freshnessFor(retained) } : null;
    return {
      profileId: profile.id,
      label: profile.label,
      enabled: profile.enabled,
      order: profile.order,
        status: this.statusFor(profile, observation, reLoginRequired),
      observation,
    };
  }

  private statusFor(
      profile: CodexLoginProfileRecord,
      observation: CodexProfileObservationSnapshot | null,
      reLoginRequired: boolean,
    ): CodexProfileRowStatus {
      if (profile.status === "pending") return "pending";
      if (observation?.freshness === "identity-changed") return "identity-changed";
      if (reLoginRequired || observation?.freshness === "re-login-required") return "re-login-required";
    if (!profile.enabled) return "disabled";
    return observation?.freshness ?? "never-observed";
  }

  private freshnessFor(snapshot: CodexProfileObservationSnapshot): CodexProfileObservationSnapshot["freshness"] {
    if (["identity-changed", "re-login-required", "stale"].includes(snapshot.freshness)) {
      return snapshot.freshness;
    }
    const now = this.now().getTime();
    const resetPassed = [snapshot.usage.primary, snapshot.usage.secondary]
      .some((window) => window?.resetsAt && new Date(window.resetsAt).getTime() <= now);
    if (resetPassed) return "refresh-needed";
      if (now - new Date(snapshot.observedAt).getTime() > CODEX_PROFILE_STALE_AFTER_MS) return "stale";
    return snapshot.freshness;
  }

  private async withProfileOperation<T>(profileId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.profileOperations.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.profileOperations.set(profileId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.profileOperations.get(profileId) === tail) this.profileOperations.delete(profileId);
    }
  }

  private async closeReadGateway(active: ActiveReadGateway): Promise<void> {
    active.closePromise ??= active.gateway.close();
    await active.closePromise;
  }
}
