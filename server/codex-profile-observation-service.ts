import type {
  CodexProfileObservationListView,
  CodexProfileObservationRowView,
  CodexProfileObservationSnapshot,
  CodexProfileRowStatus,
  UpdateCodexProfileMetadataInput,
} from "../shared/codex-profile-observation-types.js";
import { summarizeCodexProfileObservations } from "../shared/codex-profile-observation-types.js";
import { normalizeCodexAvailableCount, normalizeCodexUsageWindow } from "./codex-account-normalization.js";
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

type CodexProfileObservationRegistryLike = Pick<
  CodexLoginProfileRegistry,
  "get" | "list" | "reorder" | "updateMetadata"
>;
type CodexProfileObservationStoreLike = Pick<
  CodexProfileObservationStore,
  "get" | "list" | "reconcile" | "replace" | "remove"
>;
type StartReadGateway = (
  input: Pick<CodexMultiProfileReadGatewayStartOptions, "codexBin" | "runtimeContext" | "qualifier">,
) => Promise<CodexMultiProfileReadGatewayLike>;

type CodexProfileObservationServiceDependencies = {
  registry: CodexProfileObservationRegistryLike;
  observationStore: CodexProfileObservationStoreLike;
  codexBin: string;
  qualifier: CodexRuntimeQualifierLike;
  startReadGateway?: StartReadGateway;
  now?: () => Date;
};

export class CodexProfileObservationServiceError extends Error {
  constructor(readonly code: "profile-not-refreshable" | "identity-changed" | "read-failed" | "unavailable") {
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
      const repairedProfiles = await Promise.all(profiles.map(async (profile) => {
        if (profile.enabled && byId.get(profile.id)?.snapshot.freshness === "identity-changed") {
          return await this.registry.updateMetadata(profile.id, { enabled: false });
        }
        return profile;
      }));
      const rows = repairedProfiles.map((profile) => this.rowFor(profile, byId.get(profile.id)));
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
        if (input.enabled === true && stored?.snapshot.freshness === "identity-changed") {
          throw new CodexProfileObservationServiceError("profile-not-refreshable");
        }
        const profile = await this.registry.updateMetadata(profileId, input);
        return this.rowFor(profile, stored ? { profileId: profile.id, ...stored } : undefined);
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
    });
    this.refreshes.set(profileId, task);
    return task;
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
      gateway = await this.startReadGateway({
        codexBin: identity.canonicalPath,
        runtimeContext: runtimeContextFromIdentity(identity),
        qualifier: this.qualifier,
      });
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
      operationError = error;
    }
    try {
      await gateway?.close();
    } catch (error) {
      closeError = error;
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
      return this.rowFor(profile, { profileId: profile.id, ...stored });
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
  ): CodexProfileObservationRowView {
    const observation = profile.status === "confirmed" ? stored?.snapshot ?? null : null;
    return {
      profileId: profile.id,
      label: profile.label,
      enabled: profile.enabled,
      order: profile.order,
      status: this.statusFor(profile, observation),
      observation,
    };
  }

  private statusFor(
    profile: CodexLoginProfileRecord,
    observation: CodexProfileObservationSnapshot | null,
  ): CodexProfileRowStatus {
    if (profile.status === "pending") return "pending";
    if (observation?.freshness === "identity-changed") return "identity-changed";
    if (!profile.enabled) return "disabled";
    return observation?.freshness ?? "never-observed";
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
}
