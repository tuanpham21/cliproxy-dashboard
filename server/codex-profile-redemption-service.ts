import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
  CodexRedemptionStateView,
  PrepareCodexRedemptionInput,
} from "../shared/codex-account-types.js";
import { isRegistryProfileId } from "./codex-login-profile-registry-migration.js";
import type {
  CodexLoginProfileRecord,
  CodexLoginProfileRegistry,
} from "./codex-login-profile-registry.js";
import { PrivateRedemptionStateStore } from "./codex-redemption-private-state.js";
import type {
  CodexRedemptionDeletionDisposition,
  CodexRedemptionReloginDisposition,
} from "./codex-redemption-private-state.js";
import type { RedemptionRecoveryEvidence } from "./codex-redemption-private-digests.js";
import type { CodexProfileLifecycleStore } from "./codex-profile-lifecycle-store.js";
import {
  CodexRedemptionService,
  CodexRedemptionServiceError,
  type CodexRedemptionController,
  type CodexRedemptionPrivateStore,
  type CodexRedemptionServiceDependencies,
} from "./codex-redemption-service.js";
import type {
  CodexRuntimeIdentity,
  CodexRuntimeQualification,
  CodexRuntimeQualifierLike,
} from "./codex-runtime-qualifier.js";
import type {
  CodexProfileLifecycleFence,
  CodexProfileLifecycleOperation,
} from "./codex-profile-lifecycle-fence.js";

type CodexRedemptionProfileRegistry = Pick<CodexLoginProfileRegistry, "get" | "list">;
type ProfileScope = {
  profileId?: string;
  service: CodexRedemptionService;
};

export type CodexProfileRedemptionServiceDependencies = Omit<
  CodexRedemptionServiceDependencies,
  "qualifier" | "store"
> & {
  qualifier: CodexRuntimeQualifierLike;
  registry: CodexRedemptionProfileRegistry;
  createProfileStore?: (profileId: string) => CodexRedemptionPrivateStore;
  legacyStore?: CodexRedemptionPrivateStore;
  lifecycleFence?: Pick<CodexProfileLifecycleFence, "acquire">;
  lifecycleStore?: Pick<CodexProfileLifecycleStore, "getCleanupRequired">;
};

function incompatibleQualification(): CodexRuntimeQualification {
  return {
    status: "runtime-incompatible",
    code: "codex_runtime_incompatible",
    message: "Codex runtime or local state does not meet the required safety contract.",
  };
}

function contextMatchesIdentity(profile: CodexLoginProfileRecord, identity: CodexRuntimeIdentity): boolean {
  return profile.runtimeContext.codexStateRoot === identity.codexStateRoot &&
    profile.runtimeContext.codexSqliteRoot === identity.codexSqliteRoot;
}

class ProfileBoundRuntimeQualifier implements CodexRuntimeQualifierLike {
  constructor(
    private readonly qualifier: CodexRuntimeQualifierLike,
    private readonly resolveProfile: () => Promise<CodexLoginProfileRecord>,
  ) {}

  async qualify(codexBin: string): Promise<CodexRuntimeQualification> {
    try {
      const profile = await this.resolveProfile();
      if (profile.status !== "confirmed") return incompatibleQualification();
      return await this.qualifier.qualify(codexBin, profile.runtimeContext);
    } catch {
      return incompatibleQualification();
    }
  }

  async matchesIdentity(identity: CodexRuntimeIdentity, verifyVersion = true): Promise<boolean> {
    try {
      const profile = await this.resolveProfile();
      return profile.status === "confirmed" &&
        contextMatchesIdentity(profile, identity) &&
        await this.qualifier.matchesIdentity(identity, verifyVersion);
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {}
}

export class CodexProfileRedemptionService implements CodexRedemptionController {
  private readonly registry: CodexRedemptionProfileRegistry;
  private readonly createProfileStore: (profileId: string) => CodexRedemptionPrivateStore;
  private readonly scopeDependencies: Omit<CodexRedemptionServiceDependencies, "qualifier" | "store">;
  private readonly qualifier: CodexRuntimeQualifierLike;
  private readonly lifecycleFence?: Pick<CodexProfileLifecycleFence, "acquire">;
  private readonly lifecycleStore?: Pick<CodexProfileLifecycleStore, "getCleanupRequired">;
  private readonly legacy: ProfileScope;
  private readonly profiles = new Map<string, ProfileScope>();
  private readonly proposalScopes = new Map<string, ProfileScope>();

  constructor(dependencies: CodexProfileRedemptionServiceDependencies) {
    const {
      qualifier,
      registry,
      createProfileStore,
      legacyStore,
        lifecycleFence,
        lifecycleStore,
        ...scopeDependencies
    } = dependencies;
    this.qualifier = qualifier;
    this.registry = registry;
      this.createProfileStore = createProfileStore ?? ((profileId) => new PrivateRedemptionStateStore({ profileId }));
      this.scopeDependencies = scopeDependencies;
      this.lifecycleFence = lifecycleFence;
      this.lifecycleStore = lifecycleStore;
    this.legacy = {
      service: new CodexRedemptionService({
        ...scopeDependencies,
        qualifier,
        store: legacyStore ?? new PrivateRedemptionStateStore(),
      }),
    };
  }

  async initializeRecovery(codexBin: string): Promise<void> {
    const profiles = await this.registry.list();
    await Promise.allSettled([
      this.legacy.service.initializeRecovery(codexBin),
      ...profiles.map(async (profile) => {
        await this.profileScope(profile.id).service.initializeRecovery(codexBin);
      }),
    ]);
  }

  async prepare(
    codexBin: string,
    input: PrepareCodexRedemptionInput,
  ): Promise<CodexRedemptionProposalView> {
    if (!isRegistryProfileId(input.profileId)) {
      throw new CodexRedemptionServiceError("codex_runtime_incompatible");
    }
    return await this.withProfileFence(input.profileId, "prepare", async () => {
      const profile = await this.registry.get(input.profileId);
      if (profile.status !== "confirmed" || !profile.enabled || await this.lifecycleStore?.getCleanupRequired(input.profileId)) {
        throw new CodexRedemptionServiceError("codex_runtime_incompatible");
      }
      const scope = this.profileScope(input.profileId);
      const current = await scope.service.currentState();
      if (current.status === "recovery-required" || current.status === "unavailable") {
        throw new CodexRedemptionServiceError(current.code);
      }
      const proposal = await scope.service.prepare(codexBin, input);
      this.proposalScopes.set(proposal.proposalId, scope);
      return proposal;
    });
  }

  async state(proposalId: string): Promise<CodexRedemptionStateView> {
    const scope = await this.scopeForProposal(proposalId);
    return scope ? await scope.service.state(proposalId) : { status: "not-found" };
  }

  async currentState(profileId?: string): Promise<CodexRedemptionCurrentView> {
    if (!profileId) return await this.legacy.service.currentState();
    await this.registry.get(profileId);
    return await this.profileScope(profileId).service.currentState();
  }

  async deletionDisposition(profileId: string): Promise<CodexRedemptionDeletionDisposition> {
    await this.registry.get(profileId);
    return await this.profileScope(profileId).service.deletionDisposition();
  }

  async reloginDisposition(profileId: string, evidence: RedemptionRecoveryEvidence): Promise<CodexRedemptionReloginDisposition> {
    await this.registry.get(profileId);
    return await this.profileScope(profileId).service.reloginDisposition(evidence);
  }

  async consume(proposalId: string, codexBin?: string): Promise<CodexRedemptionCurrentView> {
    const scope = await this.scopeForProposal(proposalId);
    if (!scope) throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    const result = await this.withProfileFence(scope.profileId, "consume", async () =>
      await scope.service.consume(proposalId, codexBin));
    if (result.status === "terminal") this.proposalScopes.delete(proposalId);
    return result;
  }

  async cancel(proposalId: string): Promise<{ status: "cancelled"; proposalId: string }> {
    const scope = this.proposalScopes.get(proposalId);
    if (!scope) throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    const result = await this.withProfileFence(scope.profileId, "delete", async () =>
      await scope.service.cancel(proposalId));
    this.proposalScopes.delete(proposalId);
    return result;
  }

  async close(): Promise<void> {
    await Promise.all([
      this.legacy.service.close(),
      ...[...this.profiles.values()].map(async (scope) => await scope.service.close()),
    ]);
  }

  private profileScope(profileId: string): ProfileScope {
    const existing = this.profiles.get(profileId);
    if (existing) return existing;
    const qualifier = new ProfileBoundRuntimeQualifier(
      this.qualifier,
      async () => await this.registry.get(profileId),
    );
    const scope = {
        profileId,
        service: new CodexRedemptionService({
        ...this.scopeDependencies,
        qualifier,
        store: this.createProfileStore(profileId),
      }),
    };
    this.profiles.set(profileId, scope);
    return scope;
  }

  private async scopeForProposal(proposalId: string): Promise<ProfileScope | null> {
    const mapped = this.proposalScopes.get(proposalId);
    if (mapped) return mapped;
    for (const scope of [this.legacy, ...this.profiles.values()]) {
      const current = await scope.service.currentState();
      if ("proposalId" in current && current.proposalId === proposalId) {
        this.proposalScopes.set(proposalId, scope);
        return scope;
      }
    }
    return null;
  }

  private async withProfileFence<T>(
    profileId: string | undefined,
    operation: CodexProfileLifecycleOperation,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!profileId || !this.lifecycleFence) return await action();
    const lease = await this.lifecycleFence.acquire(profileId, operation);
    try {
      return await action();
    } finally {
      await lease.release();
    }
  }
}
