import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
  CodexRedemptionUsageSnapshot,
  PrepareCodexRedemptionInput,
} from "../shared/codex-account-types.js";
import type { CodexProfileObservationSnapshot } from "../shared/codex-profile-observation-types.js";
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
    readProfileObservation: (profileId: string) => Promise<CodexProfileObservationSnapshot | null>;
    reconcileProfileObservation: (
      profileId: string,
      snapshot: CodexRedemptionUsageSnapshot | undefined,
    ) => Promise<void>;
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
    private readonly readProfileObservation: CodexProfileRedemptionServiceDependencies["readProfileObservation"];
    private readonly reconcileProfileObservation: CodexProfileRedemptionServiceDependencies["reconcileProfileObservation"];
    private readonly legacy: ProfileScope;
    private readonly profiles = new Map<string, ProfileScope>();
    private readonly proposalScopes = new Map<string, ProfileScope>();
    private readonly proposalViews = new Map<string, CodexRedemptionProposalView>();
    private readonly reconciledProposals = new Set<string>();

  constructor(dependencies: CodexProfileRedemptionServiceDependencies) {
    const {
      qualifier,
      registry,
      createProfileStore,
      legacyStore,
          lifecycleFence,
          lifecycleStore,
          readProfileObservation,
          reconcileProfileObservation,
          ...scopeDependencies
    } = dependencies;
    this.qualifier = qualifier;
    this.registry = registry;
      this.createProfileStore = createProfileStore ?? ((profileId) => new PrivateRedemptionStateStore({ profileId }));
      this.scopeDependencies = scopeDependencies;
        this.lifecycleFence = lifecycleFence;
        this.lifecycleStore = lifecycleStore;
        this.readProfileObservation = readProfileObservation;
        this.reconcileProfileObservation = reconcileProfileObservation;
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
        const observation = await this.readProfileObservation(input.profileId);
        if (!observation || observation.freshness === "identity-changed" || observation.freshness === "re-login-required") {
          throw new CodexRedemptionServiceError("codex_runtime_incompatible");
        }
      const scope = this.profileScope(input.profileId);
      const current = await scope.service.currentState();
      if (current.status === "recovery-required" || current.status === "unavailable") {
        throw new CodexRedemptionServiceError(current.code);
      }
            const proposal = await scope.service.prepare(codexBin, {
              singleWorkspaceAttested: input.singleWorkspaceAttested,
            }, { allowAutomaticSelection: true });
        if (proposal.account.email !== observation.account.email || proposal.account.plan !== observation.account.plan) {
          await scope.service.cancel(proposal.proposalId);
          throw new CodexRedemptionServiceError("codex_account_changed");
        }
        const profileProposal = { ...proposal, profile: { profileId: profile.id, label: profile.label } };
        this.proposalScopes.set(proposal.proposalId, scope);
        this.proposalViews.set(proposal.proposalId, profileProposal);
        return profileProposal;
      });
    }

    async state(proposalId: string): Promise<CodexRedemptionCurrentView> {
      const scope = await this.scopeForProposal(proposalId);
      if (!scope) return { status: "not-found" };
      const state = await scope.service.state(proposalId);
      if (state.status === "prepared") return this.proposalViews.get(proposalId) ?? state;
      await this.reconcileTerminal(scope, state);
      return state;
    }

  async currentState(profileId?: string): Promise<CodexRedemptionCurrentView> {
    if (!profileId) return await this.legacy.service.currentState();
      await this.registry.get(profileId);
      const scope = this.profileScope(profileId);
      const state = await scope.service.currentState();
      if (state.status === "prepared") return this.proposalViews.get(state.proposalId) ?? state;
      await this.reconcileTerminal(scope, state);
      return state;
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
      const result = await this.withProfileFence(scope.profileId, "consume", async () => {
        if (scope.profileId) {
          const profile = await this.registry.get(scope.profileId);
          if (profile.status !== "confirmed" || !profile.enabled || await this.lifecycleStore?.getCleanupRequired(scope.profileId)) {
            throw new CodexRedemptionServiceError("codex_session_changed");
          }
        }
        return await scope.service.consume(proposalId, codexBin);
      });
      await this.reconcileTerminal(scope, result);
      if (result.status === "terminal") this.proposalScopes.delete(proposalId);
      return result;
  }

  async cancel(proposalId: string): Promise<{ status: "cancelled"; proposalId: string }> {
    const scope = this.proposalScopes.get(proposalId);
    if (!scope) throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    const result = await this.withProfileFence(scope.profileId, "delete", async () =>
      await scope.service.cancel(proposalId));
      this.proposalScopes.delete(proposalId);
      this.proposalViews.delete(proposalId);
      this.reconciledProposals.delete(proposalId);
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

    private async reconcileTerminal(scope: ProfileScope, state: CodexRedemptionCurrentView): Promise<void> {
      if (!scope.profileId || state.status !== "terminal" || this.reconciledProposals.has(state.proposalId)) return;
      try {
        await this.reconcileProfileObservation(scope.profileId, state.accountUsage);
        this.reconciledProposals.add(state.proposalId);
        this.proposalViews.delete(state.proposalId);
      } catch {
        // Terminal redemption remains authoritative; later state reads retry read-only reconciliation.
      }
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
