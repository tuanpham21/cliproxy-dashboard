import { randomBytes, randomUUID } from "node:crypto";

import type {
  CodexRedemptionProposalSelection,
  CodexRedemptionProposalView,
  CodexRedemptionCurrentView,
  CodexRedemptionStateView,
  LegacyPrepareCodexRedemptionInput,
  PrepareCodexRedemptionInput,
} from "../shared/codex-account-types.js";
import type { CodexAccountUsageWindow } from "../shared/types.js";
import {
  CodexAccountGateway,
  CodexAccountGatewayError,
  type CodexConsumeResetCreditOutcome,
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
import { runtimeContextFromIdentity, type CodexRuntimeContext } from "./codex-runtime-context.js";
import {
  CodexRedemptionPrivateStateError,
  PrivateRedemptionStateStore,
  type AcquirePreparedRedemptionInput,
    type PreparedRedemptionJournal,
    type RedemptionJournal,
    type PublicPrivateRedemptionState,
    type CodexRedemptionDeletionDisposition,
    type CodexRedemptionReloginDisposition,
  } from "./codex-redemption-private-state.js";
import type { CodexRuntimeIdentity, CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";
import {
  defaultCodexRedemptionAuditSink,
  type CodexRedemptionAuditSink,
} from "./codex-redemption-audit.js";
import {
  consumePrepared,
  CodexRedemptionConsumeError,
} from "./codex-redemption-consume.js";
import { selectCodexResetCredit } from "./codex-redemption-credit-selection.js";
import type {
  RedemptionJournalPhase,
  TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";
import { finishTerminalReplay } from "./codex-redemption-terminal-replay.js";
import { recoveryRequiredPrivateState, unavailablePrivateState } from "./codex-redemption-public-state.js";
import { publicRedemptionView } from "./codex-redemption-public-view.js";
import { CodexRedemptionRecoveryManager } from "./codex-redemption-recovery-manager.js";
import type { RecoveryCoordinatorStore } from "./codex-redemption-recovery-coordinator.js";
import { CodexRedemptionRecoveryError } from "./codex-redemption-recovery-error.js";

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
  | "redemption-recovery-required"
  | "codex_account_changed"
  | "codex_reset_availability_changed"
    | "codex_session_changed"
    | "codex_recovery_account_mismatch"
    | "codex_recovery_session_changed"
    | "codex_proposal_expired";

const ERROR_MESSAGES: Record<CodexRedemptionServiceErrorCode, string> = {
  codex_auth_required: "Sign in to Codex with ChatGPT, then refresh.",
  codex_runtime_unavailable: "Codex runtime unavailable. Check the configured Codex path.",
  codex_runtime_incompatible: "Codex runtime or local state does not meet the required safety contract.",
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
  codex_account_changed: "Codex app account changed before redemption. Nothing was redeemed. Review the current account and try again.",
  codex_reset_availability_changed: "Reset availability changed before redemption. Nothing was redeemed. Refresh and review the available resets.",
    codex_session_changed: "Codex session changed before redemption. Nothing was redeemed. Refresh the Codex app account panel and try again.",
    codex_recovery_account_mismatch: "Current Codex app account does not match this redemption attempt. Restore the account used for the attempt, then retry. New redemptions remain blocked.",
    codex_recovery_session_changed: "Codex recovery session changed. This redemption outcome remains unconfirmed. Restore the original qualified runtime and account, then retry. New redemptions remain blocked.",
    codex_proposal_expired: "Confirmation expired. Account details and reset availability were refreshed. Review them and try again.",
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
  consumeResetCredit?: (input: {
    idempotencyKey: string;
    creditId?: string;
    timeoutMs?: number;
    beforeWrite?: () => Promise<void> | void;
    afterWrite?: () => Promise<void> | void;
  }) => Promise<{ outcome: CodexConsumeResetCreditOutcome }>;
}

export interface CodexRedemptionPrivateStore {
  acquirePrepared(input: AcquirePreparedRedemptionInput): Promise<PreparedRedemptionJournal>;
  releasePrepared(proposalId: string, ownerNonce: string): Promise<void>;
  readPublicState(proposalId?: string): Promise<PublicPrivateRedemptionState>;
  initializeRecovery?: RecoveryCoordinatorStore["initializeRecovery"];
  claimAmbiguousRetry?: RecoveryCoordinatorStore["claimAmbiguousRetry"];
  releaseRetryClaim?: RecoveryCoordinatorStore["releaseRetryClaim"];
  verifyRecoveryEvidence?: RecoveryCoordinatorStore["verifyRecoveryEvidence"];
  transitionJournal?: (
    proposalId: string,
    ownerNonce: string,
    expectedPhase: RedemptionJournalPhase,
    next: RedemptionJournal,
  ) => Promise<RedemptionJournal>;
  publishTombstone?: (tombstone: TerminalRedemptionTombstone) => Promise<void>;
  readTombstone?: RecoveryCoordinatorStore["readTombstone"];
  readJournal?: (proposalId: string, ownerNonce: string) => Promise<RedemptionJournal | null>;
  releaseTerminal?: (proposalId: string, ownerNonce: string, auditEventId: string) => Promise<void>;
    deletionDisposition?: () => Promise<CodexRedemptionDeletionDisposition>;
  reloginDisposition?: (evidence: import("./codex-redemption-private-digests.js").RedemptionRecoveryEvidence) => Promise<CodexRedemptionReloginDisposition>;
}

export type CodexRedemptionSessionOptions = {
  codexBin: string;
  runtimeContext: CodexRuntimeContext;
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
  auditSink?: CodexRedemptionAuditSink;
};

export interface CodexRedemptionController {
  prepare(codexBin: string, input: PrepareCodexRedemptionInput): Promise<CodexRedemptionProposalView>;
  state(proposalId: string): Promise<CodexRedemptionCurrentView>;
  currentState(): Promise<CodexRedemptionCurrentView>;
  initializeRecovery(codexBin: string): Promise<void>;
  consume(proposalId: string, codexBin?: string): Promise<CodexRedemptionCurrentView>;
  cancel(proposalId: string): Promise<{ status: "cancelled"; proposalId: string }>;
  close(): Promise<void>;
}

type ActiveProposal = {
  proposal: CodexRedemptionProposalView;
  journal: RedemptionJournal;
  runtimeIdentity: CodexRuntimeIdentity;
  session: CodexRedemptionSession;
  timer: NodeJS.Timeout;
  cleanupPromise: Promise<void> | null;
  cleanupFailed: boolean;
  invalidated: boolean;
  consumePromise: Promise<CodexRedemptionCurrentView> | null;
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
  if (error instanceof CodexRedemptionConsumeError && error.code in ERROR_MESSAGES) {
    return new CodexRedemptionServiceError(error.code as CodexRedemptionServiceErrorCode);
  }
  if (error instanceof CodexRedemptionRecoveryError && error.code in ERROR_MESSAGES) {
    return new CodexRedemptionServiceError(error.code as CodexRedemptionServiceErrorCode);
  }
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
  private readonly auditSink: CodexRedemptionAuditSink;
  private readonly recovery: CodexRedemptionRecoveryManager | null;
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
    this.auditSink = dependencies.auditSink ?? defaultCodexRedemptionAuditSink;
    this.recovery = CodexRedemptionRecoveryManager.create({
      qualifier: this.qualifier,
      startSession: (options) => this.startSession(options as CodexRedemptionSessionOptions),
      gatewayForSession: (session) => this.gatewayForSession(session),
      store: this.store,
      now: this.now,
      auditSink: this.auditSink,
      schedule: this.schedule,
      clearScheduled: this.clearScheduled,
    });
  }

  async initializeRecovery(codexBin: string): Promise<void> {
    await this.recovery?.initialize(codexBin);
  }

    async prepare(
      codexBin: string,
      input: LegacyPrepareCodexRedemptionInput,
      options: { allowAutomaticSelection?: boolean } = {},
    ): Promise<CodexRedemptionProposalView> {
    if (input.singleWorkspaceAttested !== true) {
      throw new CodexRedemptionServiceError("redemption-attestation-required");
    }
    if (this.active) throw new CodexRedemptionServiceError("redemption-proposal-active");
    await this.recovery?.initialize(codexBin);
    const recoveryBlock = this.recovery?.blockingErrorCode();
    if (recoveryBlock) throw new CodexRedemptionServiceError(recoveryBlock);
    const qualification = await this.qualifier.qualify(codexBin);
    if (qualification.status !== "qualified") throw new CodexRedemptionServiceError(qualification.code);
    if (!(await this.qualifier.matchesIdentity(qualification.identity))) {
      throw new CodexRedemptionServiceError("codex_runtime_incompatible");
    }

    const proposalId = this.newProposalId();
    let invalidated = false;
      const invalidate = () => {
        invalidated = true;
        const active = this.active?.proposal.proposalId === proposalId ? this.active : null;
        if (!active) return;
        active.invalidated = true;
        if (active.journal.phase === "prepared" && !active.consumePromise) void this.cleanup(active).catch(() => {});
      };
      let session: CodexRedemptionSession | null = null;
      let journal: PreparedRedemptionJournal | null = null;
      try {
        session = await this.startSession({
          codexBin: qualification.identity.canonicalPath,
          runtimeContext: runtimeContextFromIdentity(qualification.identity),
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
      if (account === null) {
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
      const selectedCredit = selectCodexResetCredit(
        resetCredits.credits ?? [],
        input.creditId,
        options.allowAutomaticSelection,
      );
      if (selectedCredit === undefined) throw new CodexRedemptionServiceError("redemption-selection-invalid");
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
        runtimeIdentity: qualification.identity,
        session,
        timer: undefined as unknown as NodeJS.Timeout,
        cleanupPromise: null,
        cleanupFailed: false,
        invalidated: false,
        consumePromise: null,
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
    const recoveryBlock = this.recovery?.blockingErrorCode();
    if (recoveryBlock) return publicRedemptionView(
      recoveryBlock === "redemption-private-state-unavailable" ? unavailablePrivateState() : recoveryRequiredPrivateState(),
    );
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
      if (privateState.status !== "prepared") return publicRedemptionView(privateState);
      return {
        status: "prepared",
        proposalId,
        allowedAction: "cancel",
        createdAt: proposal.createdAt,
        expiresAt: proposal.expiresAt,
        selectionMode: proposal.selection.mode,
      };
    }
    return publicRedemptionView(privateState);
  }

  async currentState(): Promise<CodexRedemptionCurrentView> {
    const recoveryBlock = this.recovery?.blockingErrorCode();
    if (recoveryBlock) return publicRedemptionView(
      recoveryBlock === "redemption-private-state-unavailable" ? unavailablePrivateState() : recoveryRequiredPrivateState(),
    );
    const privateState = await this.store.readPublicState();
    if (privateState.status !== "prepared") return publicRedemptionView(privateState);
    const checked = await this.state(privateState.proposalId);
    if (checked.status !== "prepared") return checked;
    return this.active?.proposal.proposalId === privateState.proposalId ? this.active.proposal : checked;
  }

  async deletionDisposition(): Promise<CodexRedemptionDeletionDisposition> {
    if (this.active) return "blocked";
    const recoveryBlock = this.recovery?.blockingErrorCode();
    if (recoveryBlock === "redemption-private-state-unavailable") return "unavailable";
    if (recoveryBlock === "redemption-recovery-required") return "recovery-required";
    if (this.store.deletionDisposition) return await this.store.deletionDisposition();
    const current = await this.store.readPublicState();
    if (current.status === "not-found") return "safe";
    if (current.status === "unavailable") return "unavailable";
    if (current.status === "recovery-required") return "recovery-required";
    return "blocked";
  }

  async reloginDisposition(
    evidence: import("./codex-redemption-private-digests.js").RedemptionRecoveryEvidence,
  ): Promise<CodexRedemptionReloginDisposition> {
    const recoveryBlock = this.recovery?.blockingErrorCode();
    if (recoveryBlock === "redemption-private-state-unavailable") return "unavailable";
    if (recoveryBlock === "redemption-recovery-required") return "recovery-required";
    if (!this.store.reloginDisposition) return "recovery-required";
    return await this.store.reloginDisposition(evidence);
  }

  async cancel(proposalId: string): Promise<{ status: "cancelled"; proposalId: string }> {
    const active = this.active;
    if (!active || active.proposal.proposalId !== proposalId) {
      throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    }
    if (active.consumePromise) throw new CodexRedemptionServiceError("redemption-proposal-active");
    try {
      await this.cleanup(active);
    } catch {
      throw new CodexRedemptionServiceError("redemption-recovery-required");
    }
    return { status: "cancelled", proposalId };
  }

  async consume(proposalId: string, codexBin?: string): Promise<CodexRedemptionCurrentView> {
    const active = this.active?.proposal.proposalId === proposalId ? this.active : null;
    if (!active) {
      let state = await this.store.readPublicState(proposalId);
      if (
        codexBin && this.recovery &&
        (state.status === "terminal" || (state.status === "processing" && state.phase === "terminal"))
      ) {
        await this.recovery.initialize(codexBin);
        state = await this.store.readPublicState(proposalId);
      }
      if (state.status === "ambiguous" && codexBin && this.recovery) {
        return await this.recovery.retry(proposalId, codexBin).catch((error) => { throw serviceError(error); });
      }
      if (state.status === "terminal" || state.status === "ambiguous" || state.status === "processing") {
        return publicRedemptionView(state);
      }
      throw new CodexRedemptionServiceError("redemption-proposal-not-found");
    }
    if (active.consumePromise) return await active.consumePromise;
    if (active.journal.phase === "terminal") {
      if (!this.store.readJournal || !this.store.releaseTerminal) {
        throw new CodexRedemptionServiceError("redemption-recovery-required");
      }
      const state = await this.store.readPublicState(proposalId);
      if (state.status !== "terminal") return publicRedemptionView(state);
      active.consumePromise = finishTerminalReplay({
        journal: active.journal,
        tombstone: state.tombstone,
        auditSink: this.auditSink,
        codexVersion: active.journal.runtimeIdentity.version,
        session: active.session,
        store: {
          readJournal: (proposalId, ownerNonce) => this.store.readJournal!(proposalId, ownerNonce),
          releaseTerminal: (proposalId, ownerNonce, auditEventId) => this.store.releaseTerminal!(proposalId, ownerNonce, auditEventId),
        },
      }).then(() => {
        this.active = null;
        return publicRedemptionView(state);
      }).catch((error) => {
        active.consumePromise = null;
        throw serviceError(error);
      });
      return await active.consumePromise;
    }
    if (active.journal.phase !== "prepared") {
      const state = await this.store.readPublicState(proposalId);
      return publicRedemptionView(state);
    }
    if (!this.store.transitionJournal || !this.store.publishTombstone || !this.store.readJournal || !this.store.releaseTerminal) {
      throw new CodexRedemptionServiceError("redemption-recovery-required");
    }
    const gateway = this.gatewayForSession(active.session as CodexAppServerSession);
    this.clearScheduled(active.timer);
    active.consumePromise = consumePrepared({
      active,
      gateway,
      store: {
        transitionJournal: async (proposalId, ownerNonce, expectedPhase, next) => {
          const journal = await this.store.transitionJournal!(proposalId, ownerNonce, expectedPhase, next);
          active.journal = journal;
          return journal;
        },
        publishTombstone: (tombstone) => this.store.publishTombstone!(tombstone),
        releaseTerminal: (proposalId, ownerNonce, auditEventId) => this.store.releaseTerminal!(proposalId, ownerNonce, auditEventId),
        readJournal: (proposalId, ownerNonce) => this.store.readJournal!(proposalId, ownerNonce),
      },
      qualifier: this.qualifier,
      runtimeIdentity: active.runtimeIdentity,
      now: this.now,
      auditSink: this.auditSink,
      codexVersion: active.journal.runtimeIdentity.version,
    }).then((result) => {
      if (result.status === "terminal") this.active = null;
      return result;
    }).catch(async (error) => {
      if (error instanceof CodexRedemptionConsumeError && (
        error.code === "codex_account_changed" ||
        error.code === "codex_reset_availability_changed" ||
        error.code === "codex_session_changed" ||
        error.code === "codex_proposal_expired"
      )) {
        await this.cleanup(active).catch(() => {});
      }
      active.consumePromise = null;
      throw serviceError(error);
    });
    return await active.consumePromise;
  }

  async close(): Promise<void> {
    this.recovery?.close();
    if (this.active) await this.cleanup(this.active);
  }

  private async cleanup(active: ActiveProposal): Promise<void> {
    active.cleanupPromise ??= (async () => {
      this.clearScheduled(active.timer);
      try {
        await active.session.close();
        if (active.journal.phase === "prepared") {
          await this.store.releasePrepared(active.journal.proposalId, active.journal.ownerNonce);
          if (this.active === active) this.active = null;
        }
      } catch (error) {
        active.cleanupFailed = true;
        throw error;
      }
    })();
    await active.cleanupPromise;
  }

}
