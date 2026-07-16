import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  parsePreparedRedemptionJournal,
  parseRedemptionJournal,
  terminalTombstoneMatchesJournal,
  type PreparedRedemptionJournal,
  type RedemptionJournal,
  type RedemptionJournalPhase,
  type TerminalRedemptionTombstone,
  type RedemptionSelection,
} from "./codex-redemption-journal.js";
import type { CodexRuntimeIdentity } from "./codex-runtime-qualifier.js";
import { readPrivateFile as readPrivateFileChecked } from "./codex-redemption-private-files.js";
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
  accountCheckDigest,
  runtimePathDigest,
  verifyRecoveryDigests,
} from "./codex-redemption-private-digests.js";
import {
  currentProcessOwner,
  inspectProcessOwner,
  resolveFixedRoot,
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
export type { PreparedRedemptionJournal, RedemptionJournal, RedemptionSelection } from "./codex-redemption-journal.js";
export type { PublicPrivateRedemptionState } from "./codex-redemption-public-state.js";
export { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";
const DIGEST_KEY_FILE = "account-digest.key";
const ACTIVE_JOURNAL_FILE = "active-redemption.json";
const JOURNAL_MAX_BYTES = 16 * 1024;
const DIGEST_KEY_CANDIDATE = /^\.account-digest\.[A-Za-z0-9-]+\.candidate$/;
const ACTIVE_JOURNAL_CANDIDATE = /^\.active-redemption\.[A-Za-z0-9-]+\.candidate$/;
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
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
  private readonly rootPath: string;
  private readonly rootAnchorPath: string;
  private readonly currentOwner: () => Promise<ProcessOwner>;
  private readonly inspectOwner: (owner: ProcessOwner) => Promise<ProcessOwnerStatus>;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly randomUUID: () => string;
  private readonly now: () => number;

  constructor(dependencies: PrivateRedemptionStateStoreDependencies = {}) {
    const env = dependencies.env ?? process.env;
    const homedir = dependencies.homedir ?? os.homedir;
    this.platform = dependencies.platform ?? process.platform;
    this.rootPath = dependencies.rootPathForTests ?? resolveFixedRoot(
      this.platform,
      env,
      homedir,
    );
    const home = homedir();
    this.rootAnchorPath = dependencies.rootAnchorForTests
      ?? (this.platform === "linux" && env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME)
        ? env.XDG_STATE_HOME
        : this.platform === "win32" && env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)
          ? env.LOCALAPPDATA
          : home);
    this.currentOwner = dependencies.currentOwner ?? (() => currentProcessOwner(this.platform));
    this.inspectOwner = dependencies.inspectOwner ?? ((owner) => inspectProcessOwner(this.platform, owner));
    this.randomBytes = dependencies.randomBytes ?? randomBytes;
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
    this.now = dependencies.now ?? Date.now;
  }
  async acquirePrepared(input: AcquirePreparedRedemptionInput): Promise<PreparedRedemptionJournal> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.ensureWritableRoot();
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
    if (claimState !== "missing") throw new CodexRedemptionPrivateStateError(
      claimState === "active" ? "redemption-proposal-active" : "redemption-recovery-required",
    );

    const key = await this.readDigestKey(canonicalRoot, true);
    const owner = await this.currentOwner();
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !owner.processStartIdentity) {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
    const ownerNonce = this.randomBytes(32).toString("base64url");
    const journal: PreparedRedemptionJournal = {
      schemaVersion: 1,
      phase: "prepared",
      proposalId: input.proposalId,
      ownerNonce,
      owner,
        accountCheckDigest: accountCheckDigest(key, input.proposalId, input.accountCheck.email, input.accountCheck.plan),
      idempotencyKey: input.idempotencyKey,
      selection: input.selection,
      runtimeIdentity: {
          canonicalPathDigest: runtimePathDigest(key, input.runtimeIdentity.canonicalPath),
        version: input.runtimeIdentity.version,
        fileIdentity: input.runtimeIdentity.fileIdentity,
        schemaHash: input.runtimeIdentity.schemaHash,
      },
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
    const canonicalRoot = await this.verifyExistingRoot();
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
    const canonicalRoot = await this.verifyExistingRoot();
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
    const canonicalRoot = await this.verifyExistingRoot();
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
    evidence: { accountCheck: { email: string; plan: string }; runtimeIdentity: CodexRuntimeIdentity },
  ): Promise<{ accountMatches: boolean; runtimeMatches: boolean }> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyExistingRoot();
    const key = await this.readDigestKey(canonicalRoot, false);
    return verifyRecoveryDigests(key, journal, evidence);
  }
  async initializeRecovery(): Promise<RecoveryInitializationState> {
    this.assertSupportedPlatform();
    return await initializePrivateRecovery({
      rootPath: this.rootPath,
      now: this.now,
      randomUUID: this.randomUUID,
      inspectOwner: this.inspectOwner,
      verifyExistingRoot: () => this.verifyExistingRoot(),
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
      });
  }
  async claimAmbiguousRetry(proposalId: string): Promise<RetryClaimResult> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyExistingRoot();
    if (await this.readOptionalKey(canonicalRoot) !== "valid") throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    return await claimPrivateAmbiguousRetry(this.retryClaimDependencies(canonicalRoot), proposalId);
  }
  async releaseRetryClaim(proposalId: string, claimOwnerNonce: string): Promise<void> {
    this.assertSupportedPlatform();
    const canonicalRoot = await this.verifyExistingRoot();
    await releasePrivateRetryClaim(this.retryClaimDependencies(canonicalRoot), proposalId, claimOwnerNonce);
  }
  async publishTombstone(tombstone: TerminalRedemptionTombstone): Promise<void> {
      this.assertSupportedPlatform();
      const canonicalRoot = await this.verifyExistingRoot();
      await publishTerminalTombstone(this.terminalDependencies(canonicalRoot), tombstone);
  }
  async readTombstone(proposalId: string): Promise<TerminalRedemptionTombstone | null> {
      if (this.platform === "win32") return null;
      const canonicalRoot = await this.verifyExistingRoot();
      return await readTerminalTombstone(this.terminalDependencies(canonicalRoot), proposalId);
  }
  async readPublicState(proposalId?: string): Promise<PublicPrivateRedemptionState> {
    if (this.platform === "win32") return unavailablePrivateState();
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

  private assertSupportedPlatform(): void {
    if (this.platform === "win32") {
      throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    }
  }

  private async ensureWritableRoot(): Promise<string> {
    await this.assertNoSymlinkAncestors();
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(this.rootPath, READ_ONLY_NO_FOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isDirectory() || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
      await handle.chmod(0o700);
    } catch (error) {
      if (error instanceof CodexRedemptionPrivateStateError) throw error;
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    } finally {
      await handle?.close();
    }
    return await this.verifyExistingRoot();
  }
  private async assertNoSymlinkAncestors(): Promise<void> {
    const relative = path.relative(this.rootAnchorPath, this.rootPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
    try {
      const anchorMetadata = await lstat(this.rootAnchorPath);
      if (!anchorMetadata.isDirectory() || anchorMetadata.isSymbolicLink()) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
    } catch (error) {
      if (isEnoent(error)) return;
      if (error instanceof CodexRedemptionPrivateStateError) throw error;
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
    let current = this.rootAnchorPath;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        const metadata = await lstat(current);
        if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
          throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
        }
      } catch (error) {
        if (isEnoent(error)) return;
        if (error instanceof CodexRedemptionPrivateStateError) throw error;
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
    }
  }
  private async verifyExistingRoot(): Promise<string> {
    await this.assertNoSymlinkAncestors();
    const metadata = await lstat(this.rootPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
    if (this.platform !== "win32") {
      if ((metadata.mode & 0o777) !== 0o700) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
    }
    return await realpath(this.rootPath);
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
      { rootPath: this.rootPath, platform: this.platform },
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
  ): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "journal"; journal: RedemptionJournal }> {
    let content: Buffer;
    try {
          content = await this.readPrivateFile(
            activePath,
            canonicalRoot,
            2,
            JOURNAL_MAX_BYTES,
            ACTIVE_JOURNAL_CANDIDATE,
          );
    } catch (error) {
      if (isEnoent(error)) return { kind: "missing" };
      return { kind: "invalid" };
    }
    try {
      const parsed = parseRedemptionJournal(JSON.parse(content.toString("utf8")) as unknown);
      return parsed ? { kind: "journal", journal: parsed } : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
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
      await this.readPrivateFile(candidatePath, canonicalRoot, 2, JOURNAL_MAX_BYTES);
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
      await this.readPrivateFile(activePath, canonicalRoot, 2, JOURNAL_MAX_BYTES);
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
    const handle = await open(this.rootPath, READ_ONLY_NO_FOLLOW);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  private terminalDependencies(canonicalRoot: string) {
    return {
      context: { rootPath: this.rootPath, platform: this.platform },
      canonicalRoot,
      randomUUID: this.randomUUID,
      syncDirectory: () => this.syncDirectory(),
      createError: (code: "redemption-recovery-required") => new CodexRedemptionPrivateStateError(code),
      now: this.now,
    };
  }
  private retryClaimDependencies(canonicalRoot: string) {
    return {
      context: { rootPath: this.rootPath, platform: this.platform },
      canonicalRoot,
      currentOwner: this.currentOwner,
      inspectOwner: this.inspectOwner,
      randomBytes: this.randomBytes,
      randomUUID: this.randomUUID,
      now: this.now,
      syncDirectory: () => this.syncDirectory(),
      createError: () => new CodexRedemptionPrivateStateError("redemption-recovery-required"),
    };
  }
}
