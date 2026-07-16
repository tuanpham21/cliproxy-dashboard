import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  parsePreparedRedemptionJournal,
  type PreparedRedemptionJournal,
  type RedemptionSelection,
} from "./codex-redemption-journal.js";
import type { CodexRuntimeIdentity } from "./codex-runtime-qualifier.js";

export type { PreparedRedemptionJournal, RedemptionSelection } from "./codex-redemption-journal.js";

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

export type PublicPrivateRedemptionState =
  | { status: "not-found" }
  | {
      status: "prepared";
      proposalId: string;
      selectionMode: RedemptionSelection["mode"];
      createdAt: string;
      expiresAt: string;
    }
  | {
      status: "recovery-required";
      code: "redemption-recovery-required";
      message: "Reset redemption recovery state requires local repair.";
    }
  | {
      status: "unavailable";
      code: "redemption-private-state-unavailable";
      message: "Private reset redemption state is unavailable on this host.";
    };

export type CodexRedemptionPrivateStateErrorCode =
  | "redemption-private-state-unavailable"
  | "redemption-recovery-required"
  | "redemption-proposal-active"
  | "redemption-proposal-not-found"
  | "redemption-proposal-owner-mismatch";

export class CodexRedemptionPrivateStateError extends Error {
  readonly code: CodexRedemptionPrivateStateErrorCode;

  constructor(code: CodexRedemptionPrivateStateErrorCode) {
    const message =
      code === "redemption-private-state-unavailable"
        ? "Private reset redemption state is unavailable on this host."
        : code === "redemption-recovery-required"
          ? "Reset redemption recovery state requires local repair."
          : code === "redemption-proposal-active"
            ? "Another reset redemption proposal is already active."
            : code === "redemption-proposal-not-found"
              ? "Reset redemption proposal was not found."
              : "Reset redemption proposal ownership did not match.";
    super(message);
    this.name = "CodexRedemptionPrivateStateError";
    this.code = code;
  }
}

export type PrivateRedemptionStateStoreDependencies = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  rootPathForTests?: string;
  rootAnchorForTests?: string;
  currentOwner?: () => Promise<{ pid: number; processStartIdentity: string }>;
  randomBytes?: (size: number) => Buffer;
  randomUUID?: () => string;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function lengthPrefixedHmac(key: Buffer, domain: string, fields: readonly string[]): string {
  const hmac = createHmac("sha256", key);
  for (const field of [domain, ...fields]) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    hmac.update(length);
    hmac.update(bytes);
  }
  return hmac.digest("base64url");
}

function resolveFixedRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homedir: () => string): string {
  if (platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "cliproxy-dashboard", "codex-reset-redemption");
  }
  if (platform === "linux") {
    const xdg = env.XDG_STATE_HOME;
    const parent = xdg && path.isAbsolute(xdg) ? xdg : path.join(homedir(), ".local", "state");
    return path.join(parent, "cliproxy-dashboard", "codex-reset-redemption");
  }
  if (platform === "win32" && env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA)) {
    return path.win32.join(env.LOCALAPPDATA, "cliproxy-dashboard", "codex-reset-redemption");
  }
  throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
}

async function defaultCurrentOwner(platform: NodeJS.Platform): Promise<{ pid: number; processStartIdentity: string }> {
  if (platform === "linux") {
    const [bootId, statText] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${process.pid}/stat`, "utf8"),
    ]);
    const closeParen = statText.lastIndexOf(")");
    const fields = statText.slice(closeParen + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!startTicks) throw new Error("process identity unavailable");
    return { pid: process.pid, processStartIdentity: `${bootId.trim()}:${startTicks}` };
  }
  if (platform === "darwin") {
    const startedAt = await new Promise<string>((resolve, reject) => {
      execFile("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { timeout: 5_000 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout).trim());
      });
    });
    if (!startedAt) throw new Error("process identity unavailable");
    return { pid: process.pid, processStartIdentity: startedAt };
  }
  throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
}

export class PrivateRedemptionStateStore {
  private readonly platform: NodeJS.Platform;
  private readonly rootPath: string;
  private readonly rootAnchorPath: string;
  private readonly currentOwner: () => Promise<{ pid: number; processStartIdentity: string }>;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly randomUUID: () => string;

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
    this.currentOwner = dependencies.currentOwner ?? (() => defaultCurrentOwner(this.platform));
    this.randomBytes = dependencies.randomBytes ?? randomBytes;
    this.randomUUID = dependencies.randomUUID ?? randomUUID;
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
      accountCheckDigest: lengthPrefixedHmac(key, "cliproxy-dashboard/account-check/v1", [
        input.proposalId,
        input.accountCheck.email,
        input.accountCheck.plan,
      ]),
      idempotencyKey: input.idempotencyKey,
      selection: input.selection,
      runtimeIdentity: {
        canonicalPathDigest: lengthPrefixedHmac(key, "cliproxy-dashboard/runtime-path/v1", [
          input.runtimeIdentity.canonicalPath,
        ]),
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
    await unlink(activePath);
    await this.syncDirectory();
  }

  async readPublicState(proposalId?: string): Promise<PublicPrivateRedemptionState> {
    if (this.platform === "win32") return this.unavailablePublic();
    let canonicalRoot: string;
    try {
      canonicalRoot = await this.verifyExistingRoot();
    } catch (error) {
      if (isEnoent(error)) return { status: "not-found" };
      return error instanceof CodexRedemptionPrivateStateError && error.code === "redemption-private-state-unavailable"
        ? this.unavailablePublic()
        : this.recoveryPublic();
    }
    const activePath = path.join(this.rootPath, ACTIVE_JOURNAL_FILE);
    const existing = await this.readOptionalJournal(activePath, canonicalRoot);
    if (existing.kind === "invalid") return this.recoveryPublic();
    if (existing.kind === "missing") {
      const keyState = await this.readOptionalKey(canonicalRoot);
      return keyState === "invalid" ? this.recoveryPublic() : { status: "not-found" };
    }
    const keyState = await this.readOptionalKey(canonicalRoot);
    if (keyState !== "valid") return this.recoveryPublic();
    if (proposalId && existing.journal.proposalId !== proposalId) return { status: "not-found" };
    return {
      status: "prepared",
      proposalId: existing.journal.proposalId,
      selectionMode: existing.journal.selection.mode,
      createdAt: existing.journal.createdAt,
      expiresAt: existing.journal.expiresAt,
    };
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
    const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
    try {
      const metadata = await handle.stat();
      const pathMetadata = await lstat(filePath);
      const publicationLinkAllowed = publicationCandidatePattern && metadata.nlink === 2
        ? await this.hasMatchingPublicationLink(filePath, metadata.dev, metadata.ino, publicationCandidatePattern)
        : false;
      if (
        !metadata.isFile() ||
        !pathMetadata.isFile() ||
        pathMetadata.isSymbolicLink() ||
        metadata.dev !== pathMetadata.dev ||
        metadata.ino !== pathMetadata.ino ||
        (metadata.nlink !== 1 && !publicationLinkAllowed) ||
        metadata.size < minimumBytes ||
        metadata.size > maximumBytes ||
        (this.platform !== "win32" && ((metadata.mode & 0o777) !== 0o600 || (pathMetadata.mode & 0o777) !== 0o600))
      ) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
      const canonical = await realpath(filePath);
      if (!isInsideRoot(canonicalRoot, canonical)) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
      const content = await handle.readFile();
      const after = await handle.stat();
      if (
        after.dev !== metadata.dev ||
        after.ino !== metadata.ino ||
        after.size !== metadata.size ||
        after.mtimeMs !== metadata.mtimeMs ||
        (after.nlink !== metadata.nlink && !(publicationLinkAllowed && metadata.nlink === 2 && after.nlink === 1)) ||
        (after.ctimeMs !== metadata.ctimeMs && !(publicationLinkAllowed && metadata.nlink === 2 && after.nlink === 1))
      ) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
      return content;
    } finally {
      await handle.close();
    }
  }

  private async hasMatchingPublicationLink(
    publishedPath: string,
    dev: number,
    ino: number,
    candidatePattern: RegExp,
  ): Promise<boolean> {
    const current = await lstat(publishedPath);
    if (current.dev !== dev || current.ino !== ino) return false;
    if (current.nlink === 1) return true;
    if (current.nlink !== 2) return false;
    let matches = 0;
    for (const name of await readdir(this.rootPath)) {
      if (!candidatePattern.test(name)) continue;
      try {
        const candidate = await lstat(path.join(this.rootPath, name));
        if (candidate.isFile() && !candidate.isSymbolicLink() && candidate.dev === dev && candidate.ino === ino) matches += 1;
      } catch (error) {
        if (!isEnoent(error)) return false;
      }
    }
    const after = await lstat(publishedPath);
    if (after.dev !== dev || after.ino !== ino) return false;
    if (after.nlink === 1) return true;
    return after.nlink === 2 && matches === 1;
  }

  private async readOptionalJournal(
    activePath: string,
    canonicalRoot: string,
  ): Promise<{ kind: "missing" } | { kind: "invalid" } | { kind: "journal"; journal: PreparedRedemptionJournal }> {
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
        const parsed = parsePreparedRedemptionJournal(JSON.parse(content.toString("utf8")) as unknown);
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
  private recoveryPublic(): Extract<PublicPrivateRedemptionState, { status: "recovery-required" }> {
    return {
      status: "recovery-required",
      code: "redemption-recovery-required",
      message: "Reset redemption recovery state requires local repair.",
    };
  }

  private unavailablePublic(): Extract<PublicPrivateRedemptionState, { status: "unavailable" }> {
    return {
      status: "unavailable",
      code: "redemption-private-state-unavailable",
      message: "Private reset redemption state is unavailable on this host.",
    };
  }
}
