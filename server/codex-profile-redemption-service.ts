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

type CodexRedemptionProfileRegistry = Pick<CodexLoginProfileRegistry, "get" | "list">;
type ProfileScope = {
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
  private readonly legacy: ProfileScope;
  private readonly profiles = new Map<string, ProfileScope>();
  private readonly proposalScopes = new Map<string, ProfileScope>();

  constructor(dependencies: CodexProfileRedemptionServiceDependencies) {
    const {
      qualifier,
      registry,
      createProfileStore,
      legacyStore,
      ...scopeDependencies
    } = dependencies;
    this.qualifier = qualifier;
    this.registry = registry;
    this.createProfileStore = createProfileStore ?? ((profileId) => new PrivateRedemptionStateStore({ profileId }));
    this.scopeDependencies = scopeDependencies;
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
    const scope = this.profileScope(input.profileId);
    const current = await scope.service.currentState();
    if (current.status === "recovery-required" || current.status === "unavailable") {
      throw new CodexRedemptionServiceError(current.code);
    }
    const proposal = await scope.service.prepare(codexBin, input);
    this.proposalScopes.set(proposal.proposalId, scope);
    return proposal;
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

  async consume(proposalId: string, codexBin?: string): Promise<CodexRedemptionCurrentView> {
    const scope = await this.scopeForProposal(proposalId);
    if (!scope) throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    const result = await scope.service.consume(proposalId, codexBin);
    if (result.status === "terminal") this.proposalScopes.delete(proposalId);
    return result;
  }

  async cancel(proposalId: string): Promise<{ status: "cancelled"; proposalId: string }> {
    const scope = this.proposalScopes.get(proposalId);
    if (!scope) throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    const result = await scope.service.cancel(proposalId);
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
}
