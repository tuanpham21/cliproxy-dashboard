import { lstat, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
    parseRedemptionJournal,
    terminalTombstoneMatchesJournal,
  type PreparedRedemptionJournal,
  type RedemptionJournal,
  type RedemptionJournalPhase,
} from "./codex-redemption-journal.js";
import type { ProcessOwner, ProcessOwnerStatus } from "./codex-redemption-private-owner.js";
import { journalsFormAllowedTransition } from "./codex-redemption-private-terminal.js";

const ACTIVE_JOURNAL_FILE = "active-redemption.json";
const JOURNAL_MAX_BYTES = 16 * 1024;
const PREPARED_CLEANUP = /^\.active-redemption\.[A-Za-z0-9-]+\.cleanup$/;
const CLEANUP_STALE_AFTER_MS = 5_000;

type OptionalJournal = { kind: "missing" } | { kind: "invalid" } | { kind: "journal"; journal: RedemptionJournal };

export type RecoveryInitializationState =
  | { status: "idle" }
  | { status: "prepared"; journal: PreparedRedemptionJournal }
  | { status: "processing"; journal: RedemptionJournal }
  | { status: "retry-finalizing" }
    | { status: "ambiguous"; journal: RedemptionJournal }
  | { status: "terminal"; journal: RedemptionJournal }
  | { status: "recovery-required" };

export type PrivateRecoveryDependencies = {
  rootPath: string;
  now: () => number;
  randomUUID: () => string;
  inspectOwner: (owner: ProcessOwner) => Promise<ProcessOwnerStatus>;
  verifyExistingRoot: () => Promise<string>;
  readOptionalJournal: (activePath: string, canonicalRoot: string) => Promise<OptionalJournal>;
  readOptionalKey: (canonicalRoot: string) => Promise<"missing" | "valid" | "invalid">;
  transitionJournal: (
    proposalId: string,
    ownerNonce: string,
    expectedPhase: RedemptionJournalPhase,
    next: RedemptionJournal,
  ) => Promise<RedemptionJournal>;
  readPrivateFile: (filePath: string, canonicalRoot: string, minimumBytes: number, maximumBytes: number) => Promise<Buffer>;
    syncDirectory: () => Promise<void>;
    recoverRetryClaim: (canonicalRoot: string) => Promise<"missing" | "active" | "invalid">;
    readTombstone: (proposalId: string) => Promise<import("./codex-redemption-journal.js").TerminalRedemptionTombstone | null>;
    pruneExpiredTombstones: (canonicalRoot: string) => Promise<void>;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function activeJournalCleanupExists(rootPath: string): Promise<boolean> {
  try {
    return (await readdir(rootPath)).some((name) => PREPARED_CLEANUP.test(name));
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function cleanPreparedReclaimFiles(
  dependencies: PrivateRecoveryDependencies,
  canonicalRoot: string,
): Promise<boolean> {
  let names: string[];
  try {
    names = await readdir(dependencies.rootPath);
  } catch (error) {
    return isEnoent(error);
  }
    for (const name of names.filter((candidate) => PREPARED_CLEANUP.test(candidate))) {
      const cleanupPath = path.join(dependencies.rootPath, name);
      try {
        const metadata = await lstat(cleanupPath);
        const content = await dependencies.readPrivateFile(cleanupPath, canonicalRoot, 2, JOURNAL_MAX_BYTES);
        const journal = parseRedemptionJournal(JSON.parse(content.toString("utf8")) as unknown);
        if (!journal) return false;
        const active = await dependencies.readOptionalJournal(path.join(dependencies.rootPath, ACTIVE_JOURNAL_FILE), canonicalRoot);
        if (active.kind === "journal" && JSON.stringify(active.journal) === JSON.stringify(journal)) {
          await unlink(cleanupPath);
          await dependencies.syncDirectory();
          continue;
        }
        if (active.kind === "journal" && journalsFormAllowedTransition(journal, active.journal)) {
          await unlink(cleanupPath);
          await dependencies.syncDirectory();
          continue;
        }
        if (active.kind === "journal" && journal.phase === "prepared" && Date.parse(journal.expiresAt) <= dependencies.now()) {
          const ownerStatus = await dependencies.inspectOwner(journal.owner);
          if (ownerStatus !== "dead" && ownerStatus !== "pid-reused") return false;
          await unlink(cleanupPath);
          await dependencies.syncDirectory();
          continue;
        }
        if (dependencies.now() - metadata.mtimeMs < CLEANUP_STALE_AFTER_MS) continue;
        if (active.kind !== "missing") return false;
        if (journal.phase === "terminal") {
          const tombstone = await dependencies.readTombstone(journal.proposalId);
          if (!tombstone || !terminalTombstoneMatchesJournal(journal, tombstone)) return false;
          await unlink(cleanupPath);
          await dependencies.syncDirectory();
          continue;
        }
        if (journal.phase !== "prepared" || Date.parse(journal.expiresAt) > dependencies.now()) return false;
      const ownerStatus = await dependencies.inspectOwner(journal.owner);
      if (ownerStatus !== "dead" && ownerStatus !== "pid-reused") return false;
      await unlink(cleanupPath);
      await dependencies.syncDirectory();
    } catch (error) {
      if (!isEnoent(error)) return false;
    }
  }
  return true;
}

export async function initializePrivateRecovery(
  dependencies: PrivateRecoveryDependencies,
): Promise<RecoveryInitializationState> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await dependencies.verifyExistingRoot();
  } catch (error) {
    return isEnoent(error) ? { status: "idle" } : { status: "recovery-required" };
  }
  if (!(await cleanPreparedReclaimFiles(dependencies, canonicalRoot))) return { status: "recovery-required" };
  const claimState = await dependencies.recoverRetryClaim(canonicalRoot);
  if (claimState === "invalid") return { status: "recovery-required" };
  const activePath = path.join(dependencies.rootPath, ACTIVE_JOURNAL_FILE);
    const existing = await dependencies.readOptionalJournal(activePath, canonicalRoot);
    if (existing.kind === "missing") {
      if (claimState === "active") return { status: "retry-finalizing" };
      if (await dependencies.readOptionalKey(canonicalRoot) === "invalid") return { status: "recovery-required" };
      try {
        await dependencies.pruneExpiredTombstones(canonicalRoot);
        return { status: "idle" };
      } catch {
        return { status: "recovery-required" };
      }
  }
  if (existing.kind === "invalid" || await dependencies.readOptionalKey(canonicalRoot) !== "valid") {
    return { status: "recovery-required" };
  }
    const journal = existing.journal;
    if (claimState === "active") {
      return journal.phase === "ambiguous" || journal.phase === "terminal"
        ? { status: "processing", journal }
        : { status: "recovery-required" };
    }
  if (journal.phase === "prepared") {
    const prepared = journal as PreparedRedemptionJournal;
    if (Date.parse(prepared.expiresAt) > dependencies.now()) return { status: "prepared", journal: prepared };
    const ownerStatus = await dependencies.inspectOwner(prepared.owner);
    if (ownerStatus === "alive") return { status: "prepared", journal: prepared };
    if (ownerStatus === "unverifiable") return { status: "recovery-required" };
    const cleanupPath = path.join(dependencies.rootPath, `.active-redemption.${dependencies.randomUUID()}.cleanup`);
    try {
      await rename(activePath, cleanupPath);
    } catch (error) {
      if (isEnoent(error)) return await initializePrivateRecovery(dependencies);
      return { status: "recovery-required" };
    }
    await dependencies.syncDirectory();
    try {
      const content = await dependencies.readPrivateFile(cleanupPath, canonicalRoot, 2, JOURNAL_MAX_BYTES);
      const moved = parseRedemptionJournal(JSON.parse(content.toString("utf8")) as unknown);
      if (!moved || moved.phase !== "prepared" || moved.proposalId !== prepared.proposalId || moved.ownerNonce !== prepared.ownerNonce) {
        return { status: "recovery-required" };
      }
        await unlink(cleanupPath);
        await dependencies.syncDirectory();
        return await initializePrivateRecovery(dependencies);
    } catch {
      return { status: "recovery-required" };
    }
    }
    if (journal.phase === "dispatch-intent" || journal.phase === "dispatched") {
      const ownerStatus = await dependencies.inspectOwner(journal.owner);
      if (ownerStatus === "alive") return { status: "processing", journal };
      if (ownerStatus === "unverifiable") return { status: "recovery-required" };
      try {
      const ambiguous = await dependencies.transitionJournal(journal.proposalId, journal.ownerNonce, journal.phase, {
        ...journal,
        phase: "ambiguous",
        updatedAt: new Date(dependencies.now()).toISOString(),
      });
      return { status: "ambiguous", journal: ambiguous };
    } catch {
      const authoritative = await dependencies.readOptionalJournal(activePath, canonicalRoot);
      return authoritative.kind === "journal" && authoritative.journal.phase === "ambiguous"
        ? { status: "ambiguous", journal: authoritative.journal }
        : { status: "recovery-required" };
    }
    }
    if (journal.phase === "ambiguous") return { status: "ambiguous", journal };
    const ownerStatus = await dependencies.inspectOwner(journal.owner);
    if (ownerStatus === "alive") return { status: "processing", journal };
    if (ownerStatus === "unverifiable") return { status: "recovery-required" };
    return { status: "terminal", journal };
  }
