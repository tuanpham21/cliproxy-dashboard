import type { CodexRedemptionCurrentView } from "../shared/codex-account-types.js";
import type {
  CodexAccountRead,
  CodexRateLimitsRead,
  CodexConsumeResetCreditOutcome,
} from "./codex-account-gateway.js";
import type { CodexRedemptionAuditSink } from "./codex-redemption-audit.js";
import type { RedemptionJournal, TerminalRedemptionTombstone } from "./codex-redemption-journal.js";
import type { RecoveryInitializationState } from "./codex-redemption-private-recovery.js";
import type { PublicPrivateRedemptionState } from "./codex-redemption-public-state.js";
import { publicRedemptionView } from "./codex-redemption-public-view.js";
import { CodexRedemptionRecoveryError } from "./codex-redemption-recovery-error.js";
import { retryAmbiguousRedemption } from "./codex-redemption-retry.js";
import {
  recoverTerminalJournal,
  type TerminalRecoveryStore,
} from "./codex-redemption-terminal-recovery.js";
import { runtimeContextFromIdentity, type CodexRuntimeContext } from "./codex-runtime-context.js";
import type { CodexRuntimeIdentity, CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";

type RecoverySession = { close(): Promise<void> };
type RecoveryGateway = {
  readAccount(): Promise<CodexAccountRead>;
  readRateLimits(): Promise<CodexRateLimitsRead>;
  consumeResetCredit?: (input: {
    idempotencyKey: string;
    creditId?: string;
    timeoutMs?: number;
    beforeWrite?: () => Promise<void> | void;
    afterWrite?: () => Promise<void> | void;
  }) => Promise<{ outcome: CodexConsumeResetCreditOutcome }>;
};

export type RecoveryCoordinatorStore = TerminalRecoveryStore & {
  initializeRecovery(): Promise<RecoveryInitializationState>;
  claimAmbiguousRetry(proposalId: string): Promise<
    | { status: "claimed"; journal: RedemptionJournal; claimOwnerNonce: string }
    | { status: "busy"; proposalId: string }
  >;
  releaseRetryClaim(proposalId: string, claimOwnerNonce: string): Promise<void>;
  verifyRecoveryEvidence(
    journal: RedemptionJournal,
    evidence: { accountCheck: { email: string; plan: string }; runtimeIdentity: CodexRuntimeIdentity },
  ): Promise<{ accountMatches: boolean; runtimeMatches: boolean }>;
  readPublicState(proposalId?: string): Promise<PublicPrivateRedemptionState>;
  transitionJournal(
    proposalId: string,
    ownerNonce: string,
    expectedPhase: RedemptionJournal["phase"],
    next: RedemptionJournal,
  ): Promise<RedemptionJournal>;
  publishTombstone(tombstone: TerminalRedemptionTombstone): Promise<void>;
  releaseTerminal(proposalId: string, ownerNonce: string, auditEventId: string): Promise<void>;
};

export type RecoveryCoordinatorDependencies = {
  qualifier: CodexRuntimeQualifierLike;
  startSession: (options: {
    codexBin: string;
    runtimeContext: CodexRuntimeContext;
    onNotification: (notification: { method: string; params?: unknown }) => Promise<void> | void;
    onUnexpectedProcessClose: () => Promise<void> | void;
  }) => Promise<RecoverySession>;
  gatewayForSession: (session: RecoverySession) => RecoveryGateway;
  store: RecoveryCoordinatorStore;
  now: () => Date;
  auditSink: CodexRedemptionAuditSink;
};

export class CodexRedemptionRecoveryCoordinator {
  constructor(private readonly dependencies: RecoveryCoordinatorDependencies) {}

  async initialize(codexBin: string): Promise<RecoveryInitializationState> {
    const state = await this.dependencies.store.initializeRecovery();
    if (state.status === "terminal") {
      try {
        const recovered = await recoverTerminalJournal({
          journal: state.journal,
          codexBin,
          qualifier: this.dependencies.qualifier,
          startSession: this.dependencies.startSession,
          gatewayForSession: this.dependencies.gatewayForSession,
          store: this.dependencies.store,
          now: this.dependencies.now,
          auditSink: this.dependencies.auditSink,
        });
        if (!recovered) return { status: "recovery-required" };
        return await this.dependencies.store.initializeRecovery();
      } catch {
        return { status: "recovery-required" };
      }
    }
    return state;
  }

  async retry(proposalId: string, codexBin: string): Promise<CodexRedemptionCurrentView> {
    const claim = await this.dependencies.store.claimAmbiguousRetry(proposalId);
    if (claim.status === "busy") {
      return publicRedemptionView(await this.dependencies.store.readPublicState(proposalId));
    }
    let session: RecoverySession | null = null;
    try {
      const qualification = await this.dependencies.qualifier.qualify(codexBin);
      if (qualification.status !== "qualified" || !(await this.dependencies.qualifier.matchesIdentity(qualification.identity))) {
        throw new CodexRedemptionRecoveryError("codex_recovery_session_changed");
      }
      const active = {
        journal: claim.journal,
        session: null as unknown as RecoverySession,
        invalidated: false,
      };
      session = await this.dependencies.startSession({
        codexBin: qualification.identity.canonicalPath,
        runtimeContext: runtimeContextFromIdentity(qualification.identity),
        onNotification: (notification) => {
          if (notification.method === "account/updated") active.invalidated = true;
        },
        onUnexpectedProcessClose: () => {
          active.invalidated = true;
        },
      });
      active.session = session;
      const gateway = this.dependencies.gatewayForSession(session);
      const accountRead = await gateway.readAccount();
      const account = accountRead.account;
      if (active.invalidated || !account || account.type !== "chatgpt" || !account.email || account.plan === "unknown") {
        throw new CodexRedemptionRecoveryError("codex_recovery_account_mismatch");
      }
      const evidence = await this.dependencies.store.verifyRecoveryEvidence(claim.journal, {
        accountCheck: { email: account.email, plan: account.plan },
        runtimeIdentity: qualification.identity,
      });
      if (!evidence.runtimeMatches) throw new CodexRedemptionRecoveryError("codex_recovery_session_changed");
      if (!evidence.accountMatches) throw new CodexRedemptionRecoveryError("codex_recovery_account_mismatch");
      return await retryAmbiguousRedemption({
        active,
        gateway,
        store: this.dependencies.store,
        qualifier: this.dependencies.qualifier,
        runtimeIdentity: qualification.identity,
        now: this.dependencies.now,
        auditSink: this.dependencies.auditSink,
        codexVersion: claim.journal.runtimeIdentity.version,
      });
    } finally {
      await session?.close().catch(() => {});
      await this.dependencies.store.releaseRetryClaim(proposalId, claim.claimOwnerNonce);
    }
  }
}
