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
import type {
  CodexProfileLoginInput,
  CodexProfileLoginRunner,
} from "./codex-profile-login-runner.js";
import { runtimeContextFromIdentity } from "./codex-runtime-context.js";
import type {
  CodexRuntimeIdentity,
  CodexRuntimeQualifierLike,
} from "./codex-runtime-qualifier.js";

type CodexProfileRegistryLike = Pick<CodexLoginProfileRegistry, "create" | "get" | "confirm" | "cancel">;
type CodexProfileLoginRunnerLike = Pick<CodexProfileLoginRunner, "start" | "wait" | "cancel">;
type StartReadGateway = (
  input: Pick<CodexMultiProfileReadGatewayStartOptions, "codexBin" | "runtimeContext" | "qualifier">,
) => Promise<CodexMultiProfileReadGatewayLike>;

type CodexProfileOnboardingServiceDependencies = {
  registry: CodexProfileRegistryLike;
  loginRunner: CodexProfileLoginRunnerLike;
  codexBin: string;
  qualifier: CodexRuntimeQualifierLike;
  startReadGateway?: StartReadGateway;
  now?: () => Date;
};

type QualifiedProfileRuntime = {
  identity: CodexRuntimeIdentity;
  loginInput: CodexProfileLoginInput;
};

export type CodexProfileOnboardingErrorCode =
  | "profile-not-pending"
  | "login-failed"
  | "account-unavailable"
  | "read-failed"
  | "confirmation-mismatch"
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
  private readonly loginRunner: CodexProfileLoginRunnerLike;
  private readonly codexBin: string;
  private readonly qualifier: CodexRuntimeQualifierLike;
  private readonly startReadGateway: StartReadGateway;
  private readonly now: () => Date;
  private readonly candidates = new Map<string, CodexProfileCandidateView>();
  private readonly qualifiedProfiles = new Map<string, QualifiedProfileRuntime>();

  constructor(dependencies: CodexProfileOnboardingServiceDependencies) {
    this.registry = dependencies.registry;
    this.loginRunner = dependencies.loginRunner;
    this.codexBin = dependencies.codexBin;
    this.qualifier = dependencies.qualifier;
    this.startReadGateway = dependencies.startReadGateway ?? (async (input) =>
      await CodexMultiProfileReadGateway.start(input));
    this.now = dependencies.now ?? (() => new Date());
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

  async observe(profileId: string): Promise<CodexProfileCandidateView> {
    const cached = this.candidates.get(profileId);
    if (cached) return cached;
    const profile = await this.pendingProfile(profileId);
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
      if (
        account?.type !== "chatgpt" ||
        !account.email?.trim() ||
        account.plan === "unknown"
      ) {
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
    this.candidates.set(profileId, candidate);
    return candidate;
  }

  async confirm(profileId: string, input: ConfirmCodexProfileInput): Promise<CodexProfileConfirmedView> {
    const profile = await this.pendingProfile(profileId);
    const candidate = this.candidates.get(profile.id);
    if (
      !candidate ||
      input.confirmed !== true ||
      input.email.trim() !== candidate.account.email ||
      input.plan !== candidate.account.plan
    ) {
      throw new CodexProfileOnboardingError("confirmation-mismatch");
    }
    await this.registry.confirm(profile.id);
    this.candidates.delete(profile.id);
    this.qualifiedProfiles.delete(profile.id);
    return { ...candidate, status: "confirmed" };
  }

  async retry(profileId: string): Promise<CodexProfileLoginStartedView> {
    const profile = await this.pendingProfile(profileId);
    const qualified = await this.qualifyProfile(profile, "login-failed");
    const input = qualified.loginInput;
    try {
      await this.loginRunner.cancel(input);
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
  }

  async cancel(profileId: string): Promise<CodexProfileCancelledView> {
    const profile = await this.pendingProfile(profileId);
    const qualified = await this.currentQualifiedProfile(profile);
    try {
      await this.loginRunner.cancel(qualified.loginInput);
      await this.registry.cancel(profile.id);
    } catch {
      throw new CodexProfileOnboardingError("cleanup-failed");
    }
    this.candidates.delete(profile.id);
    this.qualifiedProfiles.delete(profile.id);
    return { profileId: profile.id, status: "cancelled" };
  }

  private async pendingProfile(profileId: string): Promise<CodexLoginProfileRecord> {
    try {
      const profile = await this.registry.get(profileId);
      if (profile.status !== "pending") throw new CodexProfileOnboardingError("profile-not-pending");
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
