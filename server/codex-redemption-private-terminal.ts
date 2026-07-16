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

function tombstoneFileName(proposalId: string): string {
  return `terminal-redemption-${proposalId}.json`;
}

function transitionAllowed(from: RedemptionJournalPhase, to: RedemptionJournalPhase): boolean {
  return (
    (from === "prepared" && to === "dispatch-intent") ||
    (from === "dispatch-intent" && (to === "prepared" || to === "dispatched" || to === "ambiguous")) ||
    (from === "dispatched" && (to === "ambiguous" || to === "terminal")) ||
    (from === "terminal" && to === "terminal")
  );
}

function immutableFieldsMatch(existing: RedemptionJournal, next: RedemptionJournal): boolean {
  for (const key of [
    "schemaVersion", "proposalId", "ownerNonce", "owner", "accountCheckDigest", "idempotencyKey", "selection",
    "runtimeIdentity", "createdAt", "expiresAt",
  ] as const) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(next[key])) return false;
  }
  if (existing.dispatchAt && next.dispatchAt !== existing.dispatchAt) return false;
  if (existing.phase === "terminal") {
    const reconciliationAllowed = existing.reconciliation === "pending"
      ? next.reconciliation !== "pending"
      : next.reconciliation === existing.reconciliation;
    return reconciliationAllowed && next.terminalAt === existing.terminalAt && next.outcome === existing.outcome &&
      next.auditEventId === existing.auditEventId && Date.parse(next.updatedAt) >= Date.parse(existing.updatedAt);
  }
  return true;
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
    !transitionAllowed(expectedPhase, next.phase) ||
    !immutableFieldsMatch(existing, next) ||
    !parseRedemptionJournal(next)
  ) throw dependencies.createError("redemption-recovery-required");
  const activePath = path.join(dependencies.context.rootPath, ACTIVE_JOURNAL_FILE);
  const candidatePath = path.join(dependencies.context.rootPath, `.active-redemption.${dependencies.randomUUID()}.candidate`);
  let handle;
  try {
    handle = await open(candidatePath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(next)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(candidatePath, 0o600);
    await readPrivateFile(dependencies.context, candidatePath, dependencies.canonicalRoot, 2, JOURNAL_MAX_BYTES);
    await rename(candidatePath, activePath);
    await dependencies.syncDirectory();
    return next;
  } catch (error) {
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
    return Date.parse(tombstone.expiresAt) <= dependencies.now() ? null : tombstone;
  } catch (error) {
    if (isEnoent(error)) return null;
    if (error instanceof Error && error.message === "Reset redemption recovery state requires local repair.") throw error;
    throw dependencies.createError("redemption-recovery-required");
  }
}
