import { randomBytes, randomUUID } from "node:crypto";

import type {
  CodexRedemptionProposalSelection,
  CodexRedemptionProposalView,
  CodexRedemptionCurrentView,
  CodexRedemptionStateView,
  PrepareCodexRedemptionInput,
} from "../shared/codex-account-types.js";
import type { CodexAccountUsageWindow } from "../shared/types.js";
import {
  CodexAccountGateway,
  CodexAccountGatewayError,
  type CodexAccountRead,
  type CodexRateLimitsRead,
  type CodexRateLimitWindow,
  type CodexResetCredit,
} from "./codex-account-gateway.js";
import {
  startCodexAppServerSession,
  type CodexAppServerNotification,
  type CodexAppServerSession,
} from "./codex-app-server-client.js";
import {
  CodexRedemptionPrivateStateError,
  PrivateRedemptionStateStore,
  type AcquirePreparedRedemptionInput,
  type PreparedRedemptionJournal,
  type PublicPrivateRedemptionState,
} from "./codex-redemption-private-state.js";
import type { CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";

export type CodexRedemptionServiceErrorCode =
  | "codex_auth_required"
  | "codex_runtime_unavailable"
  | "codex_runtime_incompatible"
  | "codex_identity_incomplete"
  | "codex_read_failed"
  | "redemption-attestation-required"
  | "redemption-selection-invalid"
  | "redemption-no-resets"
  | "redemption-proposal-active"
  | "redemption-proposal-not-found"
  | "redemption-proposal-invalidated"
  | "redemption-private-state-unavailable"
  | "redemption-recovery-required";

const ERROR_MESSAGES: Record<CodexRedemptionServiceErrorCode, string> = {
  codex_auth_required: "Sign in to Codex with ChatGPT, then refresh.",
  codex_runtime_unavailable: "Codex runtime unavailable. Check the configured Codex path.",
  codex_runtime_incompatible: "Installed Codex does not expose the required usage-reset methods.",
  codex_identity_incomplete: "Codex did not provide an email and known plan. Redemption is unavailable.",
  codex_read_failed: "Couldn’t load Codex app usage.",
  "redemption-attestation-required": "Confirm the single-workspace boundary before continuing.",
  "redemption-selection-invalid": "Select an available usage limit reset.",
  "redemption-no-resets": "No earned usage limit resets are available.",
  "redemption-proposal-active": "Another reset redemption proposal is already active.",
  "redemption-proposal-not-found": "Reset redemption proposal was not found.",
  "redemption-proposal-invalidated": "Reset redemption proposal is no longer valid.",
  "redemption-private-state-unavailable": "Private reset redemption state is unavailable on this host.",
  "redemption-recovery-required": "Reset redemption recovery state requires local repair.",
};

export class CodexRedemptionServiceError extends Error {
  readonly code: CodexRedemptionServiceErrorCode;

  constructor(code: CodexRedemptionServiceErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CodexRedemptionServiceError";
    this.code = code;
  }
}

export interface CodexRedemptionSession {
  close(): Promise<void>;
}

export interface CodexRedemptionAccountGateway {
  readAccount(): Promise<CodexAccountRead>;
  readRateLimits(): Promise<CodexRateLimitsRead>;
}

export interface CodexRedemptionPrivateStore {
  acquirePrepared(input: AcquirePreparedRedemptionInput): Promise<PreparedRedemptionJournal>;
  releasePrepared(proposalId: string, ownerNonce: string): Promise<void>;
  readPublicState(proposalId?: string): Promise<PublicPrivateRedemptionState>;
}

export type CodexRedemptionSessionOptions = {
  codexBin: string;
  onNotification: (notification: CodexAppServerNotification) => Promise<void> | void;
  onUnexpectedProcessClose: () => Promise<void> | void;
};

export type CodexRedemptionServiceDependencies = {
  qualifier: CodexRuntimeQualifierLike;
  startSession?: (options: CodexRedemptionSessionOptions) => Promise<CodexRedemptionSession>;
  gatewayForSession?: (session: CodexRedemptionSession) => CodexRedemptionAccountGateway;
  store?: CodexRedemptionPrivateStore;
  now?: () => Date;
  newProposalId?: () => string;
  newIdempotencyKey?: () => string;
  schedule?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearScheduled?: (timer: NodeJS.Timeout) => void;
};

export interface CodexRedemptionController {
  prepare(codexBin: string, input: PrepareCodexRedemptionInput): Promise<CodexRedemptionProposalView>;
  state(proposalId: string): Promise<CodexRedemptionStateView>;
  currentState(): Promise<CodexRedemptionCurrentView>;
  cancel(proposalId: string): Promise<{ status: "cancelled"; proposalId: string }>;
  close(): Promise<void>;
}

type ActiveProposal = {
  proposal: CodexRedemptionProposalView;
  journal: PreparedRedemptionJournal;
  session: CodexRedemptionSession;
  timer: NodeJS.Timeout;
  cleanupPromise: Promise<void> | null;
  cleanupFailed: boolean;
};

function secondsToIso(value: number | null): string | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function usageWindow(window: CodexRateLimitWindow | null): CodexAccountUsageWindow | null {
  if (!window) return null;
  return {
    usedPercent: Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100
      ? window.usedPercent
      : null,
    durationMinutes: window.windowMinutes !== null && window.windowMinutes >= 0 ? window.windowMinutes : null,
    resetsAt: secondsToIso(window.resetsAt),
  };
}

function boundedText(value: string | null, maximumBytes: number): string | null {
  if (value === null || Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  let end = maximumBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function publicSelection(credit: CodexResetCredit | null): CodexRedemptionProposalSelection {
  if (!credit) return { mode: "generic" };
  return {
    mode: "specific",
    title: boundedText(credit.title, 256) ?? "Usage limit reset",
    description: boundedText(credit.description, 2048),
    expiresAt: secondsToIso(credit.expiresAt),
  };
}

function serviceError(error: unknown): CodexRedemptionServiceError {
  if (error instanceof CodexRedemptionServiceError) return error;
  if (error instanceof CodexRedemptionPrivateStateError) {
    const code = error.code === "redemption-proposal-owner-mismatch"
      ? "redemption-recovery-required"
      : error.code;
    if (code in ERROR_MESSAGES) return new CodexRedemptionServiceError(code as CodexRedemptionServiceErrorCode);
  }
  if (error instanceof CodexAccountGatewayError && error.code === "authentication-required") {
    return new CodexRedemptionServiceError("codex_auth_required");
  }
  return new CodexRedemptionServiceError("codex_read_failed");
}

export class CodexRedemptionService implements CodexRedemptionController {
  private readonly qualifier: CodexRuntimeQualifierLike;
  private readonly startSession: (options: CodexRedemptionSessionOptions) => Promise<CodexRedemptionSession>;
  private readonly gatewayForSession: (session: CodexRedemptionSession) => CodexRedemptionAccountGateway;
  private readonly store: CodexRedemptionPrivateStore;
  private readonly now: () => Date;
  private readonly newProposalId: () => string;
  private readonly newIdempotencyKey: () => string;
  private readonly schedule: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearScheduled: (timer: NodeJS.Timeout) => void;
  private active: ActiveProposal | null = null;

  constructor(dependencies: CodexRedemptionServiceDependencies) {
    this.qualifier = dependencies.qualifier;
    this.startSession = dependencies.startSession ?? (async (options) => await startCodexAppServerSession(options));
    this.gatewayForSession = dependencies.gatewayForSession ?? ((session) => new CodexAccountGateway(session as CodexAppServerSession));
    this.store = dependencies.store ?? new PrivateRedemptionStateStore();
    this.now = dependencies.now ?? (() => new Date());
    this.newProposalId = dependencies.newProposalId ?? (() => randomBytes(32).toString("base64url"));
    this.newIdempotencyKey = dependencies.newIdempotencyKey ?? randomUUID;
    this.schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearScheduled = dependencies.clearScheduled ?? clearTimeout;
  }

  async prepare(codexBin: string, input: PrepareCodexRedemptionInput): Promise<CodexRedemptionProposalView> {
    if (input.singleWorkspaceAttested !== true) {
      throw new CodexRedemptionServiceError("redemption-attestation-required");
    }
    if (this.active) throw new CodexRedemptionServiceError("redemption-proposal-active");
    const qualification = await this.qualifier.qualify(codexBin);
    if (qualification.status !== "qualified") throw new CodexRedemptionServiceError(qualification.code);
    if (!(await this.qualifier.matchesIdentity(qualification.identity))) {
      throw new CodexRedemptionServiceError("codex_runtime_incompatible");
    }

    const proposalId = this.newProposalId();
    let invalidated = false;
    const invalidate = () => {
      invalidated = true;
      if (this.active?.proposal.proposalId === proposalId) void this.cleanup(this.active).catch(() => {});
    };
    let session: CodexRedemptionSession | null = null;
    let journal: PreparedRedemptionJournal | null = null;
    try {
      session = await this.startSession({
        codexBin: qualification.identity.canonicalPath,
        onNotification: (notification) => {
          if (notification.method === "account/updated") invalidate();
        },
        onUnexpectedProcessClose: invalidate,
      });
      if (!(await this.qualifier.matchesIdentity(qualification.identity))) {
        throw new CodexRedemptionServiceError("codex_runtime_incompatible");
      }
      const gateway = this.gatewayForSession(session);
      const accountRead = await gateway.readAccount();
      const account = accountRead.account;
      if (accountRead.requiresOpenAiAuth || account === null) {
        throw new CodexRedemptionServiceError("codex_auth_required");
      }
      if (account.type !== "chatgpt" || !account.email || account.plan === "unknown") {
        throw new CodexRedemptionServiceError("codex_identity_incomplete");
      }
      const rateLimits = await gateway.readRateLimits();
      const resetCredits = rateLimits.resetCredits;
      if (!resetCredits || resetCredits.availableCount <= 0) {
        throw new CodexRedemptionServiceError("redemption-no-resets");
      }
      const usableCredits = (resetCredits.credits ?? []).filter(
        (credit): credit is CodexResetCredit & { id: string } => credit.availability === "available" && Boolean(credit.id),
      );
      let selectedCredit: (CodexResetCredit & { id: string }) | null = null;
      if (usableCredits.length > 0) {
        const matches = usableCredits.filter((credit) => credit.id === input.creditId);
        if (matches.length !== 1) throw new CodexRedemptionServiceError("redemption-selection-invalid");
        selectedCredit = matches[0];
      } else if (input.creditId !== undefined) {
        throw new CodexRedemptionServiceError("redemption-selection-invalid");
      }
      if (invalidated) throw new CodexRedemptionServiceError("redemption-proposal-invalidated");

      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + 120_000);
      const idempotencyKey = this.newIdempotencyKey();
      journal = await this.store.acquirePrepared({
        proposalId,
        idempotencyKey,
        accountCheck: { email: account.email, plan: account.plan },
        selection: selectedCredit ? { mode: "specific", creditId: selectedCredit.id } : { mode: "generic" },
        runtimeIdentity: qualification.identity,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      if (invalidated) throw new CodexRedemptionServiceError("redemption-proposal-invalidated");
      const remainingTtlMs = expiresAt.getTime() - this.now().getTime();
      if (remainingTtlMs <= 0) throw new CodexRedemptionServiceError("redemption-proposal-invalidated");
      const proposal: CodexRedemptionProposalView = {
        status: "prepared",
        proposalId,
        allowedAction: "cancel",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        account: { email: account.email, plan: account.plan },
        usage: {
          primary: usageWindow(rateLimits.rateLimits.primary),
          secondary: usageWindow(rateLimits.rateLimits.secondary),
        },
        availableCount: resetCredits.availableCount,
        selection: publicSelection(selectedCredit),
      };
      const active = {
        proposal,
        journal,
        session,
        timer: undefined as unknown as NodeJS.Timeout,
        cleanupPromise: null,
        cleanupFailed: false,
      } satisfies ActiveProposal;
      this.active = active;
      active.timer = this.schedule(() => void this.cleanup(active).catch(() => {}), remainingTtlMs);
      return proposal;
    } catch (error) {
      let cleanupFailed = false;
      if (journal) {
        await session?.close().catch(() => {
          cleanupFailed = true;
        });
        if (!cleanupFailed) {
          await this.store.releasePrepared(journal.proposalId, journal.ownerNonce).catch(() => {
            cleanupFailed = true;
          });
        }
      } else {
        await session?.close().catch(() => {});
      }
      if (this.active?.proposal.proposalId === proposalId) {
        if (cleanupFailed) this.active.cleanupFailed = true;
        else this.active = null;
      }
      if (cleanupFailed) throw new CodexRedemptionServiceError("redemption-recovery-required");
      throw serviceError(error);
    }
  }

  async state(proposalId: string): Promise<CodexRedemptionStateView> {
    const activeAtStart = this.active?.proposal.proposalId === proposalId ? this.active : null;
    let cleanupObserved = activeAtStart?.cleanupPromise ?? null;
    if (cleanupObserved) {
      await cleanupObserved.catch(() => {});
    }
    let privateState = await this.store.readPublicState(proposalId);
    const cleanupAfterRead = activeAtStart?.cleanupPromise
      ?? (this.active?.proposal.proposalId === proposalId ? this.active.cleanupPromise : null);
    if (cleanupAfterRead && cleanupAfterRead !== cleanupObserved) {
      cleanupObserved = cleanupAfterRead;
      await cleanupObserved.catch(() => {});
      privateState = await this.store.readPublicState(proposalId);
    }
    if (this.active?.proposal.proposalId === proposalId) {
      const proposal = this.active.proposal;
      if (
        this.active.cleanupFailed ||
        privateState.status === "not-found" ||
        (privateState.status === "prepared" && (
          privateState.proposalId !== proposalId ||
          privateState.selectionMode !== proposal.selection.mode ||
          privateState.createdAt !== proposal.createdAt ||
          privateState.expiresAt !== proposal.expiresAt
        ))
      ) {
        return {
          status: "recovery-required",
          code: "redemption-recovery-required",
          message: "Reset redemption recovery state requires local repair.",
        };
      }
      if (privateState.status !== "prepared") return privateState;
      return {
        status: "prepared",
        proposalId,
        allowedAction: "cancel",
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
        selectionMode: proposal.selection.mode,
      };
    }
    return this.publicPrivateState(privateState);
  }

  async currentState(): Promise<CodexRedemptionCurrentView> {
    const privateState = await this.store.readPublicState();
    if (privateState.status !== "prepared") return this.publicPrivateState(privateState);
    const checked = await this.state(privateState.proposalId);
    if (checked.status !== "prepared") return checked;
    return this.active?.proposal.proposalId === privateState.proposalId ? this.active.proposal : checked;
  }

  async cancel(proposalId: string): Promise<{ status: "cancelled"; proposalId: string }> {
    const active = this.active;
    if (!active || active.proposal.proposalId !== proposalId) {
      throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    }
    try {
      await this.cleanup(active);
    } catch {
      throw new CodexRedemptionServiceError("redemption-recovery-required");
    }
    return { status: "cancelled", proposalId };
  }

  async close(): Promise<void> {
    if (this.active) await this.cleanup(this.active);
  }

  private async cleanup(active: ActiveProposal): Promise<void> {
    active.cleanupPromise ??= (async () => {
      this.clearScheduled(active.timer);
      try {
        await active.session.close();
        await this.store.releasePrepared(active.journal.proposalId, active.journal.ownerNonce);
        if (this.active === active) this.active = null;
      } catch (error) {
        active.cleanupFailed = true;
        throw error;
      }
    })();
    await active.cleanupPromise;
  }

  private publicPrivateState(state: PublicPrivateRedemptionState): CodexRedemptionStateView {
    if (state.status !== "prepared") return state;
    return {
      status: "prepared",
      proposalId: state.proposalId,
      allowedAction: "cancel",
      createdAt: state.createdAt,
      expiresAt: state.expiresAt,
      selectionMode: state.selectionMode,
    };
  }
}
