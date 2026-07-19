import { chmod, link, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  parseRedemptionJournal,
  parseTerminalRedemptionTombstone,
  type RedemptionJournal,
  type RedemptionJournalPhase,
  type TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";
import { readPrivateFile, type PrivateFileContext } from "./codex-redemption-private-files.js";

const ACTIVE_JOURNAL_FILE = "active-redemption.json";
const JOURNAL_MAX_BYTES = 16 * 1024;
const TOMBSTONE_MAX_BYTES = 8 * 1024;
const ACTIVE_JOURNAL_CLEANUP = /^\.active-redemption\.[A-Za-z0-9-]+\.cleanup$/;

type Dependencies = {
  context: PrivateFileContext;
  canonicalRoot: string;
  randomUUID: () => string;
  syncDirectory: () => Promise<void>;
  createError: (code: "redemption-recovery-required") => Error;
  now: () => number;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

async function unlinkIfPresent(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

function tombstoneFileName(proposalId: string): string {
  return `terminal-redemption-${proposalId}.json`;
}

function transitionAllowed(from: RedemptionJournalPhase, to: RedemptionJournalPhase): boolean {
  return (
    (from === "prepared" && to === "dispatch-intent") ||
    (from === "dispatch-intent" && (to === "prepared" || to === "dispatched" || to === "ambiguous")) ||
    (from === "dispatched" && (to === "ambiguous" || to === "terminal")) ||
    (from === "ambiguous" && to === "terminal") ||
    (from === "terminal" && to === "terminal")
  );
}

function immutableFieldsMatch(existing: RedemptionJournal, next: RedemptionJournal): boolean {
    for (const key of [
      "schemaVersion", "proposalId", "ownerNonce", "owner", "accountCheckDigest", "idempotencyKey", "selection",
      "runtimeIdentity", "profileBinding", "createdAt", "expiresAt",
  ] as const) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(next[key])) return false;
  }
    if (existing.phase !== "prepared" && next.phase !== "prepared" && next.dispatchAt !== existing.dispatchAt) return false;
    if (existing.phase === "terminal") {
      if (next.phase !== "terminal") return false;
      const reconciliationAllowed = existing.reconciliation === "pending"
      ? next.reconciliation !== "pending"
      : next.reconciliation === existing.reconciliation;
    return reconciliationAllowed && next.terminalAt === existing.terminalAt && next.outcome === existing.outcome &&
      next.auditEventId === existing.auditEventId && Date.parse(next.updatedAt) >= Date.parse(existing.updatedAt);
  }
  return true;
}

export function journalsFormAllowedTransition(existing: RedemptionJournal, next: RedemptionJournal): boolean {
  return transitionAllowed(existing.phase, next.phase) && immutableFieldsMatch(existing, next) && Boolean(parseRedemptionJournal(next));
}

async function readMovedJournal(dependencies: Dependencies, cleanupPath: string): Promise<RedemptionJournal> {
  const content = await readPrivateFile(
    dependencies.context,
    cleanupPath,
    dependencies.canonicalRoot,
    2,
    JOURNAL_MAX_BYTES,
    ACTIVE_JOURNAL_CLEANUP,
  );
  const journal = parseRedemptionJournal(JSON.parse(content.toString("utf8")) as unknown);
  if (!journal) throw dependencies.createError("redemption-recovery-required");
  return journal;
}

async function restoreMovedJournal(dependencies: Dependencies, cleanupPath: string): Promise<void> {
  await link(cleanupPath, path.join(dependencies.context.rootPath, ACTIVE_JOURNAL_FILE));
  await dependencies.syncDirectory();
  await unlinkIfPresent(cleanupPath);
  await dependencies.syncDirectory();
}

export async function transitionJournal(
  dependencies: Dependencies,
  proposalId: string,
  ownerNonce: string,
  expectedPhase: RedemptionJournalPhase,
  existing: RedemptionJournal,
  next: RedemptionJournal,
): Promise<RedemptionJournal> {
    if (
      existing.proposalId !== proposalId ||
    existing.ownerNonce !== ownerNonce ||
    existing.phase !== expectedPhase ||
    next.proposalId !== proposalId ||
    next.ownerNonce !== ownerNonce ||
      !journalsFormAllowedTransition(existing, next)
    ) throw dependencies.createError("redemption-recovery-required");
    const activePath = path.join(dependencies.context.rootPath, ACTIVE_JOURNAL_FILE);
    const candidatePath = path.join(dependencies.context.rootPath, `.active-redemption.${dependencies.randomUUID()}.candidate`);
    const cleanupPath = path.join(dependencies.context.rootPath, `.active-redemption.${dependencies.randomUUID()}.cleanup`);
    let handle;
    let sourceMoved = false;
    let published = false;
    try {
    handle = await open(candidatePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
      await chmod(candidatePath, 0o600);
      await readPrivateFile(dependencies.context, candidatePath, dependencies.canonicalRoot, 2, JOURNAL_MAX_BYTES);
      await rename(activePath, cleanupPath);
      sourceMoved = true;
      await dependencies.syncDirectory();
      const moved = await readMovedJournal(dependencies, cleanupPath);
      if (JSON.stringify(moved) !== JSON.stringify(existing)) {
        await restoreMovedJournal(dependencies, cleanupPath);
        sourceMoved = false;
        throw dependencies.createError("redemption-recovery-required");
      }
      await link(candidatePath, activePath);
      published = true;
      await dependencies.syncDirectory();
    await unlinkIfPresent(candidatePath);
    await dependencies.syncDirectory();
    await unlinkIfPresent(cleanupPath);
      sourceMoved = false;
      await dependencies.syncDirectory();
      return next;
    } catch (error) {
      if (sourceMoved && !published) {
        await restoreMovedJournal(dependencies, cleanupPath).then(() => { sourceMoved = false; }).catch(() => {});
      }
      if (error instanceof Error && error.message === "Reset redemption recovery state requires local repair.") throw error;
      throw dependencies.createError("redemption-recovery-required");
    } finally {
      await handle?.close();
      try {
        await unlink(candidatePath);
      } catch (error) {
        if (!isEnoent(error)) {
          // Candidate cleanup cannot authorize replacing active state.
        }
      }
    }
}

export async function removeActiveJournal(
  dependencies: Dependencies,
  expected: RedemptionJournal,
): Promise<"removed" | "missing"> {
  const activePath = path.join(dependencies.context.rootPath, ACTIVE_JOURNAL_FILE);
  const cleanupPath = path.join(dependencies.context.rootPath, `.active-redemption.${dependencies.randomUUID()}.cleanup`);
  try {
    await rename(activePath, cleanupPath);
  } catch (error) {
    if (isEnoent(error)) return "missing";
    throw dependencies.createError("redemption-recovery-required");
  }
  try {
    await dependencies.syncDirectory();
    const moved = await readMovedJournal(dependencies, cleanupPath);
    if (JSON.stringify(moved) !== JSON.stringify(expected)) {
      await restoreMovedJournal(dependencies, cleanupPath).catch(() => {});
      throw dependencies.createError("redemption-recovery-required");
    }
    await unlinkIfPresent(cleanupPath);
    await dependencies.syncDirectory();
    return "removed";
  } catch (error) {
    if (error instanceof Error && error.message === "Reset redemption recovery state requires local repair.") throw error;
    throw dependencies.createError("redemption-recovery-required");
  }
}

export async function publishTombstone(dependencies: Dependencies, tombstone: TerminalRedemptionTombstone): Promise<void> {
  const tombstonePath = path.join(dependencies.context.rootPath, tombstoneFileName(tombstone.proposalId));
  const candidatePath = path.join(dependencies.context.rootPath, `.tombstone.${dependencies.randomUUID()}.candidate`);
  let handle;
  try {
    handle = await open(candidatePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(tombstone)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(candidatePath, 0o600);
    await readPrivateFile(dependencies.context, candidatePath, dependencies.canonicalRoot, 2, TOMBSTONE_MAX_BYTES);
    try {
      await link(candidatePath, tombstonePath);
    } catch (error) {
      if (!isEexist(error)) throw error;
      const existingContent = await readPrivateFile(
        dependencies.context,
        tombstonePath,
        dependencies.canonicalRoot,
        2,
        TOMBSTONE_MAX_BYTES,
      );
      const existing = parseTerminalRedemptionTombstone(JSON.parse(existingContent.toString("utf8")) as unknown);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(tombstone)) {
        throw dependencies.createError("redemption-recovery-required");
      }
      return;
    }
    await dependencies.syncDirectory();
    await unlink(candidatePath);
    await dependencies.syncDirectory();
  } catch (error) {
    if (error instanceof Error && error.message === "Reset redemption recovery state requires local repair.") throw error;
    throw dependencies.createError("redemption-recovery-required");
  } finally {
    await handle?.close();
    try {
      await unlink(candidatePath);
    } catch (error) {
      if (!isEnoent(error)) {
        // Candidate cleanup cannot authorize replacing a tombstone.
      }
    }
  }
}

export async function readTombstone(
  dependencies: Dependencies,
  proposalId: string,
): Promise<TerminalRedemptionTombstone | null> {
  try {
    const content = await readPrivateFile(
      dependencies.context,
      path.join(dependencies.context.rootPath, tombstoneFileName(proposalId)),
      dependencies.canonicalRoot,
      2,
      TOMBSTONE_MAX_BYTES,
    );
    const tombstone = parseTerminalRedemptionTombstone(JSON.parse(content.toString("utf8")) as unknown);
    if (!tombstone) throw dependencies.createError("redemption-recovery-required");
    return tombstone;
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof Error && error.message === "Reset redemption recovery state requires local repair.") throw error;
    throw dependencies.createError("redemption-recovery-required");
  }
}
