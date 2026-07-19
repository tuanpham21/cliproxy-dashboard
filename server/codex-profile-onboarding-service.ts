import type {
  CodexProfileCandidateView,
  CodexProfileCancelledView,
  CodexProfileConfirmedView,
  CodexProfileLoginStartedView,
  ConfirmCodexProfileInput,
} from "../shared/codex-profile-onboarding-types.js";
import { normalizeCodexAvailableCount, normalizeCodexUsageWindow } from "./codex-account-normalization.js";
import type {
  CodexLoginProfileRecord,
  CodexLoginProfileRegistry,
} from "./codex-login-profile-registry.js";
import {
  CodexMultiProfileReadGateway,
  type CodexMultiProfileReadGatewayLike,
  type CodexMultiProfileReadGatewayStartOptions,
} from "./codex-multi-profile-read-gateway.js";
import {
  type CodexProfileObservationSnapshot,
  type CodexProfileObservationStore,
} from "./codex-profile-observation-store.js";
import type {
  CodexProfileLoginInput,
  CodexProfileLoginRunner,
} from "./codex-profile-login-runner.js";
import { runtimeContextFromIdentity } from "./codex-runtime-context.js";
import type {
  CodexRuntimeIdentity,
  CodexRuntimeQualifierLike,
} from "./codex-runtime-qualifier.js";
import type { RedemptionRecoveryEvidence } from "./codex-redemption-private-digests.js";
import type {
  CodexRedemptionReloginDisposition,
} from "./codex-redemption-private-state.js";
import type { CodexProfileLifecycleFence } from "./codex-profile-lifecycle-fence.js";
import type { CodexProfileLifecycleStore } from "./codex-profile-lifecycle-store.js";
import type { CodexProfileRedemptionService } from "./codex-profile-redemption-service.js";

type CodexProfileRegistryLike = Pick<CodexLoginProfileRegistry, "create" | "get" | "confirm" | "cancel" | "updateMetadata">;
type CodexProfileObservationStoreLike = Pick<CodexProfileObservationStore, "get" | "replace" | "remove" | "isReLoginRequired">;
type CodexProfileLoginRunnerLike = Pick<CodexProfileLoginRunner, "start" | "wait" | "cancel">;
type StartReadGateway = (
  input: Pick<CodexMultiProfileReadGatewayStartOptions, "codexBin" | "runtimeContext" | "qualifier">,
) => Promise<CodexMultiProfileReadGatewayLike>;

type CodexProfileOnboardingServiceDependencies = {
  registry: CodexProfileRegistryLike;
  observationStore: CodexProfileObservationStoreLike;
  loginRunner: CodexProfileLoginRunnerLike;
  codexBin: string;
  qualifier: CodexRuntimeQualifierLike;
  startReadGateway?: StartReadGateway;
  now?: () => Date;
  lifecycleFence?: Pick<CodexProfileLifecycleFence, "acquire">;
  lifecycleStore?: Pick<CodexProfileLifecycleStore, "getCleanupRequired">;
  redemptionService?: Pick<CodexProfileRedemptionService, "currentState" | "deletionDisposition" | "reloginDisposition">;
};

type QualifiedProfileRuntime = {
  identity: CodexRuntimeIdentity;
  loginInput: CodexProfileLoginInput;
};
type CandidateObservation = {
  view: CodexProfileCandidateView;
  runtimeVersion: string;
};

export type CodexProfileOnboardingErrorCode =
  | "profile-not-pending"
  | "login-failed"
  | "account-unavailable"
  | "read-failed"
  | "confirmation-mismatch"
  | "retained-redemption-mismatch"
  | "recovery-unavailable"
  | "profile-busy"
  | "cleanup-failed";

export class CodexProfileOnboardingError extends Error {
  constructor(readonly code: CodexProfileOnboardingErrorCode) {
    super("Codex Login Profile onboarding failed.");
    this.name = "CodexProfileOnboardingError";
  }
}

function loginInput(
  profile: CodexLoginProfileRecord,
  codexBin: string,
  runtimeContext = profile.runtimeContext,
): CodexProfileLoginInput {
  return { profileId: profile.id, codexBin, runtimeContext };
}

export class CodexProfileOnboardingService {
  private readonly registry: CodexProfileRegistryLike;
  private readonly observationStore: CodexProfileObservationStoreLike;
  private readonly loginRunner: CodexProfileLoginRunnerLike;
  private readonly codexBin: string;
  private readonly qualifier: CodexRuntimeQualifierLike;
  private readonly startReadGateway: StartReadGateway;
  private readonly now: () => Date;
  private readonly lifecycleFence?: Pick<CodexProfileLifecycleFence, "acquire">;
  private readonly lifecycleStore: Pick<CodexProfileLifecycleStore, "getCleanupRequired">;
  private readonly redemptionService?: Pick<CodexProfileRedemptionService, "currentState" | "deletionDisposition" | "reloginDisposition">;
  private readonly candidates = new Map<string, CandidateObservation>();
  private readonly qualifiedProfiles = new Map<string, QualifiedProfileRuntime>();
  private readonly reLoginLeases = new Map<string, { release(): Promise<void> }>();
  private readonly profileOperations = new Map<string, Promise<void>>();

  constructor(dependencies: CodexProfileOnboardingServiceDependencies) {
    this.registry = dependencies.registry;
    this.observationStore = dependencies.observationStore;
    this.loginRunner = dependencies.loginRunner;
    this.codexBin = dependencies.codexBin;
    this.qualifier = dependencies.qualifier;
    this.startReadGateway = dependencies.startReadGateway ?? (async (input) =>
      await CodexMultiProfileReadGateway.start(input));
    this.now = dependencies.now ?? (() => new Date());
    this.lifecycleFence = dependencies.lifecycleFence;
    this.lifecycleStore = dependencies.lifecycleStore ?? { getCleanupRequired: async () => null };
    this.redemptionService = dependencies.redemptionService;
  }

  async create(): Promise<CodexProfileLoginStartedView> {
    const profile = await this.registry.create();
    let qualified: QualifiedProfileRuntime | null = null;
    let loginStarted = false;
    try {
      qualified = await this.qualifyProfile(profile, "login-failed");
      await this.loginRunner.start(qualified.loginInput);
      loginStarted = true;
      if (!(await this.qualifier.matchesIdentity(qualified.identity))) {
        throw new CodexProfileOnboardingError("login-failed");
      }
      this.qualifiedProfiles.set(profile.id, qualified);
      return { profileId: profile.id, status: "login-in-progress" };
    } catch {
      if (qualified && loginStarted) {
        try {
          await this.loginRunner.cancel(qualified.loginInput);
        } catch {
          throw new CodexProfileOnboardingError("cleanup-failed");
        }
      }
      try {
        await this.registry.cancel(profile.id);
      } catch {
        throw new CodexProfileOnboardingError("cleanup-failed");
      }
      throw new CodexProfileOnboardingError("login-failed");
    }
  }

  async startReLogin(profileId: string): Promise<CodexProfileLoginStartedView> {
    return await this.withProfileOperation(profileId, async () => {
      if (this.reLoginLeases.has(profileId)) return { profileId, status: "login-in-progress" };
      let lease: { release(): Promise<void> } | null = null;
      try {
        if (this.lifecycleFence) lease = await this.lifecycleFence.acquire(profileId, "re-login");
        let profile: CodexLoginProfileRecord;
        try {
          profile = await this.registry.get(profileId);
        } catch {
          throw new CodexProfileOnboardingError("profile-not-pending");
        }
        if (profile.status !== "confirmed" || await this.lifecycleStore.getCleanupRequired(profileId)) {
          throw new CodexProfileOnboardingError("profile-not-pending");
        }
        if (this.redemptionService) {
          const readiness = await this.redemptionService.deletionDisposition(profileId);
          if (readiness === "recovery-required" || readiness === "unavailable") {
            throw new CodexProfileOnboardingError("recovery-unavailable");
          }
          if (readiness === "blocked") {
            const current = await this.redemptionService.currentState(profileId);
            if (current.status !== "ambiguous") throw new CodexProfileOnboardingError("recovery-unavailable");
          }
        }
        await this.registry.updateMetadata(profileId, { enabled: false });
        const qualified = await this.qualifyProfile(profile, "login-failed");
        try {
          await this.loginRunner.cancel(qualified.loginInput);
        } catch {
          throw new CodexProfileOnboardingError("cleanup-failed");
        }
        await this.loginRunner.start(qualified.loginInput);
        this.qualifiedProfiles.set(profileId, qualified);
        if (lease) this.reLoginLeases.set(profileId, lease);
        return { profileId, status: "login-in-progress" };
      } catch (error) {
        await lease?.release().catch(() => {});
        if (error instanceof CodexProfileOnboardingError) throw error;
        const code = (error as { code?: unknown }).code === "profile-busy" ? "profile-busy" : "login-failed";
        throw new CodexProfileOnboardingError(code);
      }
    });
  }

  async observe(profileId: string): Promise<CodexProfileCandidateView> {
    const cached = this.candidates.get(profileId);
    if (cached) return cached.view;
    const profile = await this.candidateProfile(profileId);
    try {
      await this.loginRunner.wait(profileId);
    } catch {
      throw new CodexProfileOnboardingError("login-failed");
    }
    const qualified = await this.qualifyProfile(profile, "read-failed");

    let gateway: CodexMultiProfileReadGatewayLike | null = null;
    let candidate: CodexProfileCandidateView | null = null;
    let operationError: unknown;
    try {
      gateway = await this.startReadGateway({
        codexBin: qualified.identity.canonicalPath,
        runtimeContext: runtimeContextFromIdentity(qualified.identity),
        qualifier: this.qualifier,
      });
      const accountRead = await gateway.readAccount();
      const account = accountRead.account;
      if (account?.type !== "chatgpt" || !account.email?.trim() || account.plan === "unknown") {
        throw new CodexProfileOnboardingError("account-unavailable");
      }
      const rateLimits = await gateway.readRateLimits();
      candidate = {
        profileId,
        status: "awaiting-confirmation",
        account: { email: account.email.trim(), plan: account.plan },
        observedAt: this.now().toISOString(),
        usage: {
          primary: normalizeCodexUsageWindow(rateLimits.rateLimits.primary),
          secondary: normalizeCodexUsageWindow(rateLimits.rateLimits.secondary),
        },
        resetCredits: { availableCount: normalizeCodexAvailableCount(rateLimits.resetCredits?.availableCount) },
      };
    } catch (error) {
      operationError = error;
    }
    try {
      await gateway?.close();
    } catch {
      throw new CodexProfileOnboardingError("cleanup-failed");
    }
    if (operationError instanceof CodexProfileOnboardingError) throw operationError;
    if (operationError || !candidate) throw new CodexProfileOnboardingError("read-failed");
    this.candidates.set(profileId, { view: candidate, runtimeVersion: qualified.identity.version });
    return candidate;
  }

  async confirm(profileId: string, input: ConfirmCodexProfileInput): Promise<CodexProfileConfirmedView> {
    return await this.withProfileOperation(profileId, async () => {
      const profile = await this.candidateProfile(profileId);
      const candidate = this.candidates.get(profile.id);
        if (!candidate || input.confirmed !== true ||
        input.email.trim() !== candidate.view.account.email || input.plan !== candidate.view.account.plan) {
        throw new CodexProfileOnboardingError("confirmation-mismatch");
      }
        const current = await this.observationStore.get(profile.id);
      const snapshot: CodexProfileObservationSnapshot = {
        account: { ...candidate.view.account },
        observedAt: candidate.view.observedAt,
        usage: {
          primary: candidate.view.usage.primary ? { ...candidate.view.usage.primary } : null,
          secondary: candidate.view.usage.secondary ? { ...candidate.view.usage.secondary } : null,
        },
        resetCredits: { ...candidate.view.resetCredits },
        runtimeVersion: candidate.runtimeVersion,
        freshness: "fresh",
      };
        if (profile.status === "confirmed") {
          const qualified = this.qualifiedProfiles.get(profile.id);
          if (!qualified || !this.redemptionService) throw new CodexProfileOnboardingError("recovery-unavailable");
          const disposition = await this.redemptionService.reloginDisposition(profile.id, {
            accountCheck: candidate.view.account,
            runtimeIdentity: qualified.identity,
          });
          if (disposition === "mismatch") throw new CodexProfileOnboardingError("retained-redemption-mismatch");
          if (disposition === "recovery-required" || disposition === "unavailable") {
            throw new CodexProfileOnboardingError("recovery-unavailable");
          }
          await this.observationStore.replace(profile.id, current?.generation ?? null, snapshot);
          try {
            await this.registry.updateMetadata(profile.id, { enabled: true });
          } catch {
            throw new CodexProfileOnboardingError("cleanup-failed");
          }
          await this.reLoginLeases.get(profile.id)?.release();
          this.reLoginLeases.delete(profile.id);
        } else {
          await this.observationStore.replace(profile.id, current?.generation ?? null, snapshot);
          try {
            await this.registry.confirm(profile.id);
          } catch (error) {
            try {
              await this.observationStore.remove(profile.id);
            } catch {
              throw new CodexProfileOnboardingError("cleanup-failed");
            }
            throw error;
          }
        }
      this.candidates.delete(profile.id);
      this.qualifiedProfiles.delete(profile.id);
      return { ...candidate.view, status: "confirmed" };
    });
  }

  async retry(profileId: string): Promise<CodexProfileLoginStartedView> {
    return await this.withProfileOperation(profileId, async () => {
      const profile = await this.candidateProfile(profileId);
        const qualified = await this.qualifyProfile(profile, "login-failed");
        const input = qualified.loginInput;
        try {
          await this.loginRunner.cancel(input);
          if (profile.status === "pending") await this.observationStore.remove(profile.id);
        } catch {
        throw new CodexProfileOnboardingError("cleanup-failed");
      }
        this.candidates.delete(profile.id);
      try {
        await this.loginRunner.start(input);
        if (!(await this.qualifier.matchesIdentity(qualified.identity))) {
          await this.loginRunner.cancel(input).catch(() => {});
          throw new CodexProfileOnboardingError("login-failed");
        }
          this.qualifiedProfiles.set(profile.id, qualified);
        return { profileId: profile.id, status: "login-in-progress" };
      } catch {
        throw new CodexProfileOnboardingError("login-failed");
      }
    });
  }

  async cancel(profileId: string): Promise<CodexProfileCancelledView> {
    return await this.withProfileOperation(profileId, async () => {
      const profile = await this.candidateProfile(profileId);
        const qualified = await this.currentQualifiedProfile(profile);
        try {
          await this.loginRunner.cancel(qualified.loginInput);
          if (profile.status === "pending") {
            await this.registry.cancel(profile.id);
            await this.observationStore.remove(profile.id);
          } else {
            await this.reLoginLeases.get(profile.id)?.release();
            this.reLoginLeases.delete(profile.id);
          }
      } catch {
        throw new CodexProfileOnboardingError("cleanup-failed");
      }
      this.candidates.delete(profile.id);
      this.qualifiedProfiles.delete(profile.id);
      return { profileId: profile.id, status: "cancelled" };
    });
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

    private async candidateProfile(profileId: string): Promise<CodexLoginProfileRecord> {
      try {
        const profile = await this.registry.get(profileId);
        if (profile.status !== "pending" && !this.reLoginLeases.has(profileId)) {
          throw new CodexProfileOnboardingError("profile-not-pending");
        }
        return profile;
    } catch (error) {
      if (error instanceof CodexProfileOnboardingError) throw error;
      throw new CodexProfileOnboardingError("profile-not-pending");
    }
  }

  private async currentQualifiedProfile(profile: CodexLoginProfileRecord): Promise<QualifiedProfileRuntime> {
    const current = this.qualifiedProfiles.get(profile.id);
    if (current && await this.qualifier.matchesIdentity(current.identity)) return current;
    return await this.qualifyProfile(profile, "cleanup-failed");
  }

  private async qualifyProfile(
    profile: CodexLoginProfileRecord,
    errorCode: CodexProfileOnboardingErrorCode,
  ): Promise<QualifiedProfileRuntime> {
    try {
      const qualification = await this.qualifier.qualify(this.codexBin, profile.runtimeContext);
      if (qualification.status !== "qualified" || !(await this.qualifier.matchesIdentity(qualification.identity))) {
        throw new CodexProfileOnboardingError(errorCode);
      }
      return {
        identity: qualification.identity,
        loginInput: loginInput(
          profile,
          qualification.identity.canonicalPath,
          runtimeContextFromIdentity(qualification.identity),
        ),
      };
    } catch (error) {
      if (error instanceof CodexProfileOnboardingError) throw error;
      throw new CodexProfileOnboardingError(errorCode);
    }
  }
}
