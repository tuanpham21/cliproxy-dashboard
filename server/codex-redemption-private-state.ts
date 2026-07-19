import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  parsePreparedRedemptionJournal,
  terminalTombstoneMatchesJournal,
  type PreparedRedemptionJournal,
  type RedemptionJournal,
  type RedemptionJournalPhase,
  type TerminalRedemptionTombstone,
  type RedemptionSelection,
} from "./codex-redemption-journal.js";
import type { CodexRuntimeIdentity } from "./codex-runtime-qualifier.js";
import {
  readPrivateFile as readPrivateFileChecked,
  type PrivateFileContext,
} from "./codex-redemption-private-files.js";
import {
  publishTombstone as publishTerminalTombstone,
  readTombstone as readTerminalTombstone,
  removeActiveJournal,
  transitionJournal as transitionPrivateJournal,
} from "./codex-redemption-private-terminal.js";
import {
  publicStateFromJournal,
  recoveryRequiredPrivateState,
  type PublicPrivateRedemptionState,
  unavailablePrivateState,
} from "./codex-redemption-public-state.js";
import { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";
import {
  createPrivateFilesystemCapability,
  type PrivateFilesystemCapability,
} from "./codex-redemption-private-filesystem.js";
import { ensureWritablePrivateRoot, verifyExistingPrivateRoot } from "./codex-redemption-private-root.js";
import {
  createWindowsPrivatePathSecurity,
  type WindowsPrivatePathSecurity,
} from "./codex-redemption-windows-security.js";
import {
  accountCheckDigest,
  profileRootRuntimeDigest,
  runtimePathDigest,
  verifyRecoveryDigests,
  type RedemptionRecoveryEvidence,
  type RedemptionRecoveryEvidenceMatch,
} from "./codex-redemption-private-digests.js";
import {
  currentProcessOwner,
  inspectProcessOwner,
  type ProcessOwner,
  type ProcessOwnerStatus,
} from "./codex-redemption-private-owner.js";
import { activeJournalCleanupExists, initializePrivateRecovery, type RecoveryInitializationState } from "./codex-redemption-private-recovery.js";
import { findLatestPublicTombstone, pruneExpiredPublicTombstones } from "./codex-redemption-private-tombstone-index.js";
import {
  claimAmbiguousRetry as claimPrivateAmbiguousRetry,
  recoverRetryClaim as recoverPrivateRetryClaim,
  releaseRetryClaim as releasePrivateRetryClaim,
  retryClaimState,
  type RetryClaimResult,
} from "./codex-redemption-private-claim.js";
import {
  privateRedemptionRootContext,
  resolvePrivateRedemptionStateLocation,
} from "./codex-redemption-private-location.js";
import {
  bindTerminalTombstoneToScope,
  redemptionStateTargetsProfileId,
} from "./codex-redemption-profile-binding.js";
import {
  PRIVATE_REDEMPTION_JOURNAL_MAX_BYTES,
  readOptionalPrivateRedemptionJournal,
  type OptionalPrivateRedemptionJournal,
} from "./codex-redemption-private-journal-file.js";
export type { PreparedRedemptionJournal, RedemptionJournal, RedemptionSelection } from "./codex-redemption-journal.js";
export type { PublicPrivateRedemptionState } from "./codex-redemption-public-state.js";
export { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";
const DIGEST_KEY_FILE = "account-digest.key";
const ACTIVE_JOURNAL_FILE = "active-redemption.json";
const DIGEST_KEY_CANDIDATE = /^\.account-digest\.[A-Za-z0-9-]+\.candidate$/;
export type AcquirePreparedRedemptionInput = {
  proposalId: string;
  idempotencyKey: string;
  accountCheck: { email: string; plan: string };
  selection: RedemptionSelection;
  runtimeIdentity: CodexRuntimeIdentity;
  createdAt: string;
  expiresAt: string;
};
export type PrivateRedemptionStateStoreDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  rootPathForTests?: string;
  rootAnchorForTests?: string;
  currentOwner?: () => Promise<ProcessOwner>;
  inspectOwner?: (owner: ProcessOwner) => Promise<ProcessOwnerStatus>;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
  now?: () => number;
  windowsSecurity?: WindowsPrivatePathSecurity;
  filesystem?: PrivateFilesystemCapability;
  windowsLocalApplicationData?: () => string;
  profileId?: string;
};
function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}
export type { RecoveryInitializationState } from "./codex-redemption-private-recovery.js";
export class PrivateRedemptionStateStore {
  private readonly platform: NodeJS.Platform;
  private rootPath: string;
  private rootAnchorPath: string;
  private readonly currentOwner: () => Promise<ProcessOwner>;
  private readonly inspectOwner: (owner: ProcessOwner) => Promise<ProcessOwnerStatus>;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly randomUUID: () => string;
  private readonly now: () => number;
  private readonly windowsSecurity?: WindowsPrivatePathSecurity;
  private readonly filesystem: PrivateFilesystemCapability;
  private readonly profileId?: string;
  private rootResolutionFailed: boolean;
  private readonly retryRootResolution: (() => { rootPath: string; rootAnchorPath: string }) | null;

  constructor(dependencies: PrivateRedemptionStateStoreDependencies = {}) {
    const env = dependencies.env ?? process.env;
    this.platform = dependencies.platform ?? process.platform;
    const location = resolvePrivateRedemptionStateLocation({ ...dependencies, platform: this.platform, env });
    this.rootPath = location.rootPath;
    this.rootAnchorPath = location.rootAnchorPath;
    this.rootResolutionFailed = location.resolutionFailed;
    this.retryRootResolution = location.retryResolution;
    this.profileId = dependencies.profileId;
    this.currentOwner = dependencies.currentOwner ?? (() => currentProcessOwner(this.platform));
    this.inspectOwner = dependencies.inspectOwner ?? ((owner) => inspectProcessOwner(this.platform, owner));
    this.randomBytes = dependencies.randomBytes ?? randomBytes;
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
    this.now = dependencies.now ?? Date.now;
    this.windowsSecurity = dependencies.windowsSecurity ?? (this.platform === "win32" ? createWindowsPrivatePathSecurity() : undefined);
    this.filesystem = dependencies.filesystem ?? createPrivateFilesystemCapability({ platform: this.platform });
  }
  async acquirePrepared(input: AcquirePreparedRedemptionInput): Promise<PreparedRedemptionJournal> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.ensureWritableRoot();
    await this.qualifyFilesystem();
    const activePath = path.join(this.rootPath, ACTIVE_JOURNAL_FILE);
    const existing = await this.readOptionalJournal(activePath, canonicalRoot);
    if (existing.kind === "invalid") throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    if (existing.kind === "journal") {
      await this.readDigestKey(canonicalRoot, false);
      throw new CodexRedemptionPrivateStateError("redemption-proposal-active");
    }
    if (await activeJournalCleanupExists(this.rootPath)) {
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
    const claimState = await retryClaimState(this.retryClaimDependencies(canonicalRoot));
    if (claimState !== "missing") {
      throw new CodexRedemptionPrivateStateError(
        claimState === "active" ? "redemption-proposal-active" : "redemption-recovery-required",
      );
    }

    const key = await this.readDigestKey(canonicalRoot, true);
    let owner: ProcessOwner;
    try {
      owner = await this.currentOwner();
    } catch {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.processStartIdentity) {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
    const ownerNonce = this.randomBytes(32).toString("base64url");
      const journal: PreparedRedemptionJournal = {
        schemaVersion: this.profileId ? 2 : 1,
      phase: "prepared",
      proposalId: input.proposalId,
      ownerNonce,
      owner,
      accountCheckDigest: accountCheckDigest(key, input.proposalId, input.accountCheck.email, input.accountCheck.plan),
      idempotencyKey: input.idempotencyKey,
        selection: input.selection,
        runtimeIdentity: {
          canonicalPathDigest: runtimePathDigest(
            key,
            input.runtimeIdentity.canonicalPath,
            input.runtimeIdentity.codexStateRoot,
            input.runtimeIdentity.codexSqliteRoot,
          ),
        version: input.runtimeIdentity.version,
        fileIdentity: input.runtimeIdentity.fileIdentity,
          schemaHash: input.runtimeIdentity.schemaHash,
        },
        ...(this.profileId ? {
          profileBinding: {
            profileId: this.profileId,
            profileRootRuntimeDigest: profileRootRuntimeDigest(key, this.profileId, input.runtimeIdentity),
          },
        } : {}),
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      updatedAt: input.createdAt,
    };
    if (!parsePreparedRedemptionJournal(journal)) {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }

    try {
      await this.publishJournal(journal, canonicalRoot);
      return journal;
    } catch (error) {
      if (error instanceof CodexRedemptionPrivateStateError) throw error;
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
  }
  async releasePrepared(proposalId: string, ownerNonce: string): Promise<void> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyMutableRoot();
    const activePath = path.join(this.rootPath, ACTIVE_JOURNAL_FILE);
    const existing = await this.readOptionalJournal(activePath, canonicalRoot);
    if (existing.kind === "missing") throw new CodexRedemptionPrivateStateError("redemption-proposal-not-found");
    if (existing.kind === "invalid") throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    if (existing.journal.proposalId !== proposalId) {
      throw new CodexRedemptionPrivateStateError("redemption-proposal-not-found");
    }
    if (existing.journal.ownerNonce !== ownerNonce) {
      throw new CodexRedemptionPrivateStateError("redemption-proposal-owner-mismatch");
    }
    if (existing.journal.phase !== "prepared") throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    const removed = await removeActiveJournal(this.terminalDependencies(canonicalRoot), existing.journal);
    if (removed === "missing") throw new CodexRedemptionPrivateStateError("redemption-proposal-not-found");
  }
  async releaseTerminal(proposalId: string, ownerNonce: string, auditEventId: string): Promise<void> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyMutableRoot();
    const activePath = path.join(this.rootPath, ACTIVE_JOURNAL_FILE);
    const existing = await this.readOptionalJournal(activePath, canonicalRoot);
    const tombstone = await this.readTombstone(proposalId);
    if (existing.kind === "missing" && tombstone?.auditEventId === auditEventId) return;
    if (existing.kind !== "journal" || existing.journal.phase !== "terminal") {
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
    if (
      existing.journal.proposalId !== proposalId || existing.journal.ownerNonce !== ownerNonce ||
      existing.journal.auditEventId !== auditEventId || tombstone?.auditEventId !== auditEventId
    ) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    await removeActiveJournal(this.terminalDependencies(canonicalRoot), existing.journal);
  }
  async transitionJournal(proposalId: string, ownerNonce: string, expectedPhase: RedemptionJournalPhase, next: RedemptionJournal): Promise<RedemptionJournal> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyMutableRoot();
    const existing = await this.readOptionalJournal(path.join(this.rootPath, ACTIVE_JOURNAL_FILE), canonicalRoot);
    if (existing.kind !== "journal") throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    return await transitionPrivateJournal(
      this.terminalDependencies(canonicalRoot), proposalId, ownerNonce, expectedPhase, existing.journal, next,
    );
  }
  async readJournal(proposalId: string, ownerNonce: string): Promise<RedemptionJournal | null> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyExistingRoot();
    const existing = await this.readOptionalJournal(path.join(this.rootPath, ACTIVE_JOURNAL_FILE), canonicalRoot);
    if (existing.kind === "missing") return null;
    if (existing.kind === "invalid" || existing.journal.proposalId !== proposalId || existing.journal.ownerNonce !== ownerNonce) {
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
    return existing.journal;
  }
    async verifyRecoveryEvidence(
      journal: RedemptionJournal,
      evidence: RedemptionRecoveryEvidence,
    ): Promise<RedemptionRecoveryEvidenceMatch> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyExistingRoot();
      const key = await this.readDigestKey(canonicalRoot, false);
      return verifyRecoveryDigests(key, journal, evidence, this.profileId);
  }
  async initializeRecovery(): Promise<RecoveryInitializationState> {
    this.retryUnavailableRoot();
    try {
      this.assertSupportedPlatform();
      return await initializePrivateRecovery({
        rootPath: this.rootPath,
        now: this.now,
        randomUUID: this.randomUUID,
        inspectOwner: this.inspectOwner,
        verifyExistingRoot: () => this.verifyMutableRoot(),
        readOptionalJournal: (activePath, canonicalRoot) => this.readOptionalJournal(activePath, canonicalRoot),
        readOptionalKey: (canonicalRoot) => this.readOptionalKey(canonicalRoot),
        transitionJournal: (proposalId, ownerNonce, expectedPhase, next) =>
          this.transitionJournal(proposalId, ownerNonce, expectedPhase, next),
        readPrivateFile: (filePath, canonicalRoot, minimumBytes, maximumBytes) =>
          this.readPrivateFile(filePath, canonicalRoot, minimumBytes, maximumBytes),
        syncDirectory: () => this.syncDirectory(),
        recoverRetryClaim: (canonicalRoot) => recoverPrivateRetryClaim(this.retryClaimDependencies(canonicalRoot)),
        readTombstone: (proposalId) => this.readTombstone(proposalId),
          pruneExpiredTombstones: () => pruneExpiredPublicTombstones(
            this.rootPath, this.now(), (proposalId) => this.readTombstone(proposalId), () => this.syncDirectory(),
          ),
          journalMatchesScope: (journal) => redemptionStateTargetsProfileId(journal, this.profileId),
      });
    } catch (error) {
      if (error instanceof CodexRedemptionPrivateStateError && error.code === "redemption-private-state-unavailable") {
        return { status: "unavailable" };
      }
      throw error;
    }
  }
  async claimAmbiguousRetry(proposalId: string): Promise<RetryClaimResult> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyMutableRoot();
    if (await this.readOptionalKey(canonicalRoot) !== "valid") throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    return await claimPrivateAmbiguousRetry(this.retryClaimDependencies(canonicalRoot), proposalId);
  }
  async releaseRetryClaim(proposalId: string, claimOwnerNonce: string): Promise<void> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyMutableRoot();
    await releasePrivateRetryClaim(this.retryClaimDependencies(canonicalRoot), proposalId, claimOwnerNonce);
  }
    async publishTombstone(tombstone: TerminalRedemptionTombstone): Promise<void> {
      this.assertSupportedPlatform();
      const canonicalRoot = await this.verifyMutableRoot();
      const existing = await this.readOptionalJournal(path.join(this.rootPath, ACTIVE_JOURNAL_FILE), canonicalRoot);
      if (existing.kind !== "journal") throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      const bound = bindTerminalTombstoneToScope(tombstone, existing.journal, this.profileId);
      if (!bound) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      await publishTerminalTombstone(this.terminalDependencies(canonicalRoot), bound);
    }
    async readTombstone(proposalId: string): Promise<TerminalRedemptionTombstone | null> {
      const canonicalRoot = await this.verifyExistingRoot();
      const tombstone = await readTerminalTombstone(this.terminalDependencies(canonicalRoot), proposalId);
      if (tombstone && !redemptionStateTargetsProfileId(tombstone, this.profileId)) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
      return tombstone;
  }
  async readPublicState(proposalId?: string): Promise<PublicPrivateRedemptionState> {
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.verifyExistingRoot();
    } catch (error) {
      if (isEnoent(error)) return { status: "not-found" };
      return error instanceof CodexRedemptionPrivateStateError && error.code === "redemption-private-state-unavailable"
        ? unavailablePrivateState()
        : recoveryRequiredPrivateState();
    }
    const activePath = path.join(this.rootPath, ACTIVE_JOURNAL_FILE);
    const existing = await this.readOptionalJournal(activePath, canonicalRoot);
    if (existing.kind === "invalid") return recoveryRequiredPrivateState();
    if (existing.kind === "missing") {
      const tombstone = proposalId
        ? await this.readTombstone(proposalId)
        : await findLatestPublicTombstone(this.rootPath, this.now(), (id) => this.readTombstone(id));
      if (tombstone && Date.parse(tombstone.expiresAt) > this.now()) return { status: "terminal", tombstone };
      const keyState = await this.readOptionalKey(canonicalRoot);
      return keyState === "invalid" ? recoveryRequiredPrivateState() : { status: "not-found" };
    }
    const keyState = await this.readOptionalKey(canonicalRoot);
    if (keyState !== "valid") return recoveryRequiredPrivateState();
    if (proposalId && existing.journal.proposalId !== proposalId) return { status: "not-found" };
    if (existing.journal.phase === "ambiguous") {
      try {
        const claimState = await retryClaimState(this.retryClaimDependencies(canonicalRoot));
        if (claimState === "invalid") return recoveryRequiredPrivateState();
        if (claimState === "active") {
          return {
            status: "processing",
            proposalId: existing.journal.proposalId,
            selectionMode: existing.journal.selection.mode,
            phase: "retrying",
            dispatchAt: existing.journal.dispatchAt,
          };
        }
      } catch {
        return recoveryRequiredPrivateState();
      }
    }
    const tombstone = existing.journal.phase === "terminal" ? await this.readTombstone(existing.journal.proposalId) : null;
    if (tombstone && !terminalTombstoneMatchesJournal(existing.journal, tombstone)) return recoveryRequiredPrivateState();
    const publicTombstone = tombstone && Date.parse(tombstone.expiresAt) > this.now() ? tombstone : null;
    return publicStateFromJournal(existing.journal, publicTombstone);
  }
    private retryUnavailableRoot(): void {
      if (!this.rootResolutionFailed || !this.retryRootResolution) return;
      try {
        ({ rootPath: this.rootPath, rootAnchorPath: this.rootAnchorPath } = this.retryRootResolution());
        this.rootResolutionFailed = false;
      } catch {}
  }
  private assertSupportedPlatform(): void {
    if (this.rootResolutionFailed || (this.platform !== "darwin" && this.platform !== "linux" && this.platform !== "win32")) {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
  }

  private async ensureWritableRoot(): Promise<string> {
      if (this.rootResolutionFailed) throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
      return await ensureWritablePrivateRoot(privateRedemptionRootContext(this.platform, this.rootPath, this.rootAnchorPath, this.windowsSecurity));
  }
  private async verifyExistingRoot(): Promise<string> {
    if (this.rootResolutionFailed) throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
      return await verifyExistingPrivateRoot(privateRedemptionRootContext(this.platform, this.rootPath, this.rootAnchorPath, this.windowsSecurity));
  }
  private async verifyMutableRoot(): Promise<string> {
    const canonicalRoot = await this.verifyExistingRoot();
    await this.qualifyFilesystem();
    return canonicalRoot;
  }
  private async qualifyFilesystem(): Promise<void> {
    await this.filesystem.qualifyRoot(this.rootPath, async (filePath) => {
      if (this.platform === "win32") await this.windowsSecurity!.verifyPrivatePath(filePath, false);
    });
  }
  private async readDigestKey(canonicalRoot: string, createIfMissing: boolean): Promise<Buffer> {
    const keyPath = path.join(this.rootPath, DIGEST_KEY_FILE);
    try {
      return await this.readPrivateFile(keyPath, canonicalRoot, 32, 32, DIGEST_KEY_CANDIDATE);
    } catch (error) {
      if (!isEnoent(error)) {
        throw error instanceof CodexRedemptionPrivateStateError
          ? error
          : new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
    }
    if (!createIfMissing) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    const key = this.randomBytes(32);
    const candidatePath = path.join(this.rootPath, `.account-digest.${this.randomUUID()}.candidate`);
    let handle;
    try {
      handle = await open(candidatePath, "wx", 0o600);
      await handle.writeFile(key);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(candidatePath, 0o600);
      await this.readPrivateFile(candidatePath, canonicalRoot, 32, 32);
      try {
        await link(candidatePath, keyPath);
      } catch (error) {
        if (isEexist(error)) {
          return await this.readPrivateFile(keyPath, canonicalRoot, 32, 32, DIGEST_KEY_CANDIDATE);
        }
        throw error;
      }
      await this.syncDirectory();
      await unlink(candidatePath);
      await this.syncDirectory();
      return await this.readPrivateFile(keyPath, canonicalRoot, 32, 32, DIGEST_KEY_CANDIDATE);
    } catch (error) {
      if (error instanceof CodexRedemptionPrivateStateError) throw error;
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    } finally {
      await handle?.close();
      try {
        await unlink(candidatePath);
      } catch (error) {
        if (!isEnoent(error)) {
          // Candidate cleanup failure cannot authorize replacing the published key.
        }
      }
    }
  }
  private async readOptionalKey(canonicalRoot: string): Promise<"missing" | "valid" | "invalid"> {
    try {
      await this.readPrivateFile(
        path.join(this.rootPath, DIGEST_KEY_FILE),
        canonicalRoot,
        32,
        32,
        DIGEST_KEY_CANDIDATE,
      );
      return "valid";
    } catch (error) {
      return isEnoent(error) ? "missing" : "invalid";
    }
  }
  private async readPrivateFile(
    filePath: string,
    canonicalRoot: string,
    minimumBytes: number,
    maximumBytes: number,
    publicationCandidatePattern?: RegExp,
  ): Promise<Buffer> {
    return await readPrivateFileChecked(
      this.privateFileContext(),
      filePath,
      canonicalRoot,
      minimumBytes,
      maximumBytes,
      publicationCandidatePattern,
    );
  }

    private async readOptionalJournal(
      activePath: string,
      canonicalRoot: string,
    ): Promise<OptionalPrivateRedemptionJournal> {
      return await readOptionalPrivateRedemptionJournal({
        activePath,
        canonicalRoot,
        profileId: this.profileId,
        readPrivateFile: (...args) => this.readPrivateFile(...args),
      });
  }
  private async publishJournal(journal: PreparedRedemptionJournal, canonicalRoot: string): Promise<void> {
    const activePath = path.join(this.rootPath, ACTIVE_JOURNAL_FILE);
    const candidatePath = path.join(this.rootPath, `.active-redemption.${this.randomUUID()}.candidate`);
      const text = `${JSON.stringify(journal)}\n`;
    let handle;
    try {
      handle = await open(candidatePath, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(candidatePath, 0o600);
        await this.readPrivateFile(candidatePath, canonicalRoot, 2, PRIVATE_REDEMPTION_JOURNAL_MAX_BYTES);
      try {
        await link(candidatePath, activePath);
      } catch (error) {
        if (isEexist(error)) {
          const existing = await this.readOptionalJournal(activePath, canonicalRoot);
          if (existing.kind === "invalid") {
            throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
          }
          throw new CodexRedemptionPrivateStateError("redemption-proposal-active");
        }
        throw error;
      }
      await this.syncDirectory();
      await unlink(candidatePath);
      await this.syncDirectory();
        await this.readPrivateFile(activePath, canonicalRoot, 2, PRIVATE_REDEMPTION_JOURNAL_MAX_BYTES);
    } finally {
      await handle?.close();
      try {
        await unlink(candidatePath);
      } catch (error) {
        if (!isEnoent(error)) {
          // Candidate cleanup failure leaves no authority to remove another process's active journal.
        }
      }
    }
  }
  private async syncDirectory(): Promise<void> {
    await this.filesystem.syncDirectory(this.rootPath);
  }
  private privateFileContext(): PrivateFileContext {
    return {
      rootPath: this.rootPath,
      platform: this.platform,
      verifyPrivatePath: this.platform === "win32"
        ? async (targetPath) => await this.windowsSecurity!.verifyPrivatePath(targetPath, false)
        : undefined,
    };
  }
  private terminalDependencies(canonicalRoot: string) {
    return {
      context: this.privateFileContext(),
      canonicalRoot,
      randomUUID: this.randomUUID,
      syncDirectory: () => this.syncDirectory(),
      createError: (code: "redemption-recovery-required") => new CodexRedemptionPrivateStateError(code),
      now: this.now,
    };
  }
  private retryClaimDependencies(canonicalRoot: string) {
    return {
      context: this.privateFileContext(),
      canonicalRoot,
      currentOwner: this.currentOwner,
      inspectOwner: this.inspectOwner,
      randomBytes: this.randomBytes,
      randomUUID: this.randomUUID,
      now: this.now,
      syncDirectory: () => this.syncDirectory(),
        createError: () => new CodexRedemptionPrivateStateError("redemption-recovery-required"),
        profileId: this.profileId,
      };
  }
}
