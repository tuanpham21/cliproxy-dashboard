import { chmod, link, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { parseRedemptionJournal, type RedemptionJournal } from "./codex-redemption-journal.js";
import { readPrivateFile, type PrivateFileContext } from "./codex-redemption-private-files.js";
import type { ProcessOwner, ProcessOwnerStatus } from "./codex-redemption-private-owner.js";

const ACTIVE_JOURNAL_FILE = "active-redemption.json";
const RETRY_CLAIM_FILE = "active-redemption.retry-claim.json";
const JOURNAL_MAX_BYTES = 16 * 1024;
const CLAIM_MAX_BYTES = 4 * 1024;
const ACTIVE_JOURNAL_CANDIDATE = /^\.active-redemption\.[A-Za-z0-9-]+\.candidate$/;
const RETRY_CLAIM_CANDIDATE = /^\.retry-claim\.[A-Za-z0-9-]+\.candidate$/;
const RETRY_CLAIM_CLEANUP = /^\.retry-claim\.[A-Za-z0-9-]+\.cleanup$/;

type RetryClaim = {
  schemaVersion: 1;
  proposalId: string;
  claimOwnerNonce: string;
  owner: ProcessOwner;
  createdAt: string;
};

export type RetryClaimResult =
  | { status: "claimed"; journal: RedemptionJournal; claimOwnerNonce: string }
  | { status: "busy"; proposalId: string };

export type RetryClaimDependencies = {
  context: PrivateFileContext;
  canonicalRoot: string;
  currentOwner: () => Promise<ProcessOwner>;
  inspectOwner: (owner: ProcessOwner) => Promise<ProcessOwnerStatus>;
  randomBytes: (size: number) => Buffer;
  randomUUID: () => string;
  now: () => number;
  syncDirectory: () => Promise<void>;
  createError: () => Error;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function parseClaim(value: unknown): RetryClaim | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const claim = value as Record<string, unknown>;
  if (Object.keys(claim).sort().join(",") !== "claimOwnerNonce,createdAt,owner,proposalId,schemaVersion") return null;
  if (claim.schemaVersion !== 1 || typeof claim.proposalId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(claim.proposalId)) return null;
  if (typeof claim.claimOwnerNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(claim.claimOwnerNonce)) return null;
  if (typeof claim.createdAt !== "string" || !Number.isFinite(Date.parse(claim.createdAt))) return null;
  if (typeof claim.owner !== "object" || claim.owner === null || Array.isArray(claim.owner)) return null;
  const owner = claim.owner as Record<string, unknown>;
  if (Object.keys(owner).sort().join(",") !== "pid,processStartIdentity") return null;
  if (!Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.processStartIdentity !== "string" || !owner.processStartIdentity) return null;
  return claim as RetryClaim;
}

async function readClaim(dependencies: RetryClaimDependencies): Promise<RetryClaim | null> {
  try {
    const content = await readPrivateFile(
      dependencies.context,
      path.join(dependencies.context.rootPath, RETRY_CLAIM_FILE),
      dependencies.canonicalRoot,
      2,
      CLAIM_MAX_BYTES,
      RETRY_CLAIM_CANDIDATE,
    );
    const claim = parseClaim(JSON.parse(content.toString("utf8")) as unknown);
    if (!claim) throw dependencies.createError();
    return claim;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error instanceof Error && error.message === "Reset redemption recovery state requires local repair."
      ? error
      : dependencies.createError();
  }
}

async function readMovedClaim(dependencies: RetryClaimDependencies, cleanupPath: string): Promise<RetryClaim> {
  const content = await readPrivateFile(
    dependencies.context,
    cleanupPath,
    dependencies.canonicalRoot,
    2,
    CLAIM_MAX_BYTES,
    RETRY_CLAIM_CLEANUP,
  );
  const claim = parseClaim(JSON.parse(content.toString("utf8")) as unknown);
  if (!claim) throw dependencies.createError();
  return claim;
}

function claimsMatch(left: RetryClaim, right: RetryClaim): boolean {
  return left.proposalId === right.proposalId &&
    left.claimOwnerNonce === right.claimOwnerNonce &&
    left.owner.pid === right.owner.pid &&
    left.owner.processStartIdentity === right.owner.processStartIdentity &&
    left.createdAt === right.createdAt;
}

async function restoreMovedClaim(dependencies: RetryClaimDependencies, cleanupPath: string): Promise<void> {
  await link(cleanupPath, path.join(dependencies.context.rootPath, RETRY_CLAIM_FILE));
  await dependencies.syncDirectory();
  await unlink(cleanupPath);
  await dependencies.syncDirectory();
}

async function readAmbiguousJournal(dependencies: RetryClaimDependencies, proposalId: string): Promise<RedemptionJournal> {
  const content = await readPrivateFile(
    dependencies.context,
    path.join(dependencies.context.rootPath, ACTIVE_JOURNAL_FILE),
    dependencies.canonicalRoot,
    2,
    JOURNAL_MAX_BYTES,
    ACTIVE_JOURNAL_CANDIDATE,
  );
  const journal = parseRedemptionJournal(JSON.parse(content.toString("utf8")) as unknown);
  if (!journal || journal.phase !== "ambiguous" || journal.proposalId !== proposalId) throw dependencies.createError();
  return journal;
}

export async function retryClaimState(
  dependencies: RetryClaimDependencies,
): Promise<"missing" | "active" | "stale" | "invalid"> {
  let claim: RetryClaim | null;
  try {
    claim = await readClaim(dependencies);
  } catch {
    return "invalid";
  }
  if (!claim) return "missing";
  const ownerStatus = await dependencies.inspectOwner(claim.owner);
  if (ownerStatus === "alive") return "active";
  if (ownerStatus === "unverifiable") return "invalid";
  return "stale";
}

export async function recoverRetryClaim(
  dependencies: RetryClaimDependencies,
): Promise<"missing" | "active" | "invalid"> {
  let claim: RetryClaim | null;
  try {
    claim = await readClaim(dependencies);
  } catch {
    return "invalid";
  }
  if (!claim) return "missing";
  const ownerStatus = await dependencies.inspectOwner(claim.owner);
  if (ownerStatus === "alive") return "active";
  if (ownerStatus === "unverifiable") return "invalid";
  const cleanupPath = path.join(dependencies.context.rootPath, `.retry-claim.${dependencies.randomUUID()}.cleanup`);
    try {
      await rename(path.join(dependencies.context.rootPath, RETRY_CLAIM_FILE), cleanupPath);
    } catch (error) {
      return isEnoent(error) ? "missing" : "invalid";
    }
    await dependencies.syncDirectory();
    let moved: RetryClaim;
    try {
      moved = await readMovedClaim(dependencies, cleanupPath);
    } catch {
      return "invalid";
    }
    if (!claimsMatch(claim, moved)) {
      await restoreMovedClaim(dependencies, cleanupPath).catch(() => {});
      return "invalid";
    }
    await unlink(cleanupPath);
    await dependencies.syncDirectory();
    return "missing";
}

export async function claimAmbiguousRetry(
  dependencies: RetryClaimDependencies,
  proposalId: string,
): Promise<RetryClaimResult> {
  const journal = await readAmbiguousJournal(dependencies, proposalId);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = await dependencies.currentOwner();
    const claim: RetryClaim = {
      schemaVersion: 1,
      proposalId,
      claimOwnerNonce: dependencies.randomBytes(32).toString("base64url"),
      owner,
      createdAt: new Date(dependencies.now()).toISOString(),
    };
    const candidatePath = path.join(dependencies.context.rootPath, `.retry-claim.${dependencies.randomUUID()}.candidate`);
    let handle;
    let published = false;
    try {
      handle = await open(candidatePath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(claim)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await chmod(candidatePath, 0o600);
      await readPrivateFile(dependencies.context, candidatePath, dependencies.canonicalRoot, 2, CLAIM_MAX_BYTES);
      try {
        await link(candidatePath, path.join(dependencies.context.rootPath, RETRY_CLAIM_FILE));
        published = true;
      } catch (error) {
        if (!isEexist(error)) throw error;
        const existing = await readClaim(dependencies);
        if (!existing || existing.proposalId !== proposalId) throw dependencies.createError();
        const ownerStatus = await dependencies.inspectOwner(existing.owner);
        if (ownerStatus === "alive") return { status: "busy", proposalId };
        if (ownerStatus === "unverifiable") throw dependencies.createError();
        const cleanupPath = path.join(dependencies.context.rootPath, `.retry-claim.${dependencies.randomUUID()}.cleanup`);
          try {
            await rename(path.join(dependencies.context.rootPath, RETRY_CLAIM_FILE), cleanupPath);
          } catch (renameError) {
          if (isEnoent(renameError)) continue;
            throw renameError;
          }
          await dependencies.syncDirectory();
          const moved = await readMovedClaim(dependencies, cleanupPath);
          if (!claimsMatch(existing, moved)) {
            await restoreMovedClaim(dependencies, cleanupPath).catch(() => {});
            throw dependencies.createError();
          }
          await unlink(cleanupPath);
        await dependencies.syncDirectory();
        continue;
      }
      await dependencies.syncDirectory();
      await unlink(candidatePath);
      await dependencies.syncDirectory();
      const authoritative = await readAmbiguousJournal(dependencies, proposalId);
      return { status: "claimed", journal: authoritative, claimOwnerNonce: claim.claimOwnerNonce };
    } catch (error) {
      if (published) {
        try {
          const existing = await readClaim(dependencies);
          if (existing?.claimOwnerNonce === claim.claimOwnerNonce) {
            await unlink(path.join(dependencies.context.rootPath, RETRY_CLAIM_FILE));
            await dependencies.syncDirectory();
          }
        } catch {
          // Failed cleanup remains fail-closed recovery state.
        }
      }
      if (error instanceof Error && error.message === "Reset redemption recovery state requires local repair.") throw error;
      throw dependencies.createError();
    } finally {
      await handle?.close();
      try {
        await unlink(candidatePath);
      } catch (error) {
        if (!isEnoent(error)) {
          // Candidate cleanup cannot authorize another retry claimant.
        }
      }
    }
  }
  return { status: "busy", proposalId };
}

export async function releaseRetryClaim(
  dependencies: RetryClaimDependencies,
  proposalId: string,
  claimOwnerNonce: string,
): Promise<void> {
  const claim = await readClaim(dependencies);
  if (!claim) return;
  if (claim.proposalId !== proposalId || claim.claimOwnerNonce !== claimOwnerNonce) throw dependencies.createError();
  try {
    await unlink(path.join(dependencies.context.rootPath, RETRY_CLAIM_FILE));
    await dependencies.syncDirectory();
  } catch {
    const authoritative = await readClaim(dependencies).catch(() => { throw dependencies.createError(); });
    if (!authoritative) return;
    throw dependencies.createError();
  }
}
