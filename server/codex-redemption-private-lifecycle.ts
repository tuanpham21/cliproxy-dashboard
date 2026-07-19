import path from "node:path";

import {
  terminalTombstoneMatchesJournal,
  type TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";
import {
  verifyRecoveryDigests,
  type RedemptionRecoveryEvidence,
} from "./codex-redemption-private-digests.js";
import { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";
import type { OptionalPrivateRedemptionJournal } from "./codex-redemption-private-journal-file.js";
import { findLatestPublicTombstone } from "./codex-redemption-private-tombstone-index.js";
import { redemptionStateTargetsProfileId } from "./codex-redemption-profile-binding.js";
import {
  publicStateFromJournal,
  recoveryRequiredPrivateState,
  type PublicPrivateRedemptionState,
  unavailablePrivateState,
} from "./codex-redemption-public-state.js";

const ACTIVE_JOURNAL_FILE = "active-redemption.json";

export type CodexRedemptionDeletionDisposition = "safe" | "blocked" | "recovery-required" | "unavailable";
export type CodexRedemptionReloginDisposition =
  | "unbound"
  | "matching-retained"
  | "mismatch"
  | "recovery-required"
  | "unavailable";

type PrivateRedemptionLifecycleDependencies = {
  rootPath: string;
  profileId?: string;
  now: () => number;
  verifyExistingRoot: () => Promise<string>;
  readOptionalJournal: (activePath: string, canonicalRoot: string) => Promise<OptionalPrivateRedemptionJournal>;
  readOptionalKey: (canonicalRoot: string) => Promise<"missing" | "valid" | "invalid">;
  retryClaimState: (canonicalRoot: string) => Promise<"missing" | "active" | "stale" | "invalid">;
  readDigestKey: (canonicalRoot: string) => Promise<Buffer>;
  readTombstone: (proposalId: string) => Promise<TerminalRedemptionTombstone | null>;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function unavailableOrRecoveryRequired(error: unknown): "unavailable" | "recovery-required" {
  return error instanceof CodexRedemptionPrivateStateError && error.code === "redemption-private-state-unavailable"
    ? "unavailable"
    : "recovery-required";
}

export async function readPrivateRedemptionPublicState(
  dependencies: PrivateRedemptionLifecycleDependencies,
  proposalId?: string,
): Promise<PublicPrivateRedemptionState> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await dependencies.verifyExistingRoot();
  } catch (error) {
    if (isEnoent(error)) return { status: "not-found" };
    return unavailableOrRecoveryRequired(error) === "unavailable"
      ? unavailablePrivateState()
      : recoveryRequiredPrivateState();
  }
  const existing = await dependencies.readOptionalJournal(
    path.join(dependencies.rootPath, ACTIVE_JOURNAL_FILE),
    canonicalRoot,
  );
  if (existing.kind === "invalid") return recoveryRequiredPrivateState();
  if (existing.kind === "missing") {
    const tombstone = proposalId
      ? await dependencies.readTombstone(proposalId)
      : await findLatestPublicTombstone(dependencies.rootPath, dependencies.now(), dependencies.readTombstone);
    if (tombstone && Date.parse(tombstone.expiresAt) > dependencies.now()) return { status: "terminal", tombstone };
    const keyState = await dependencies.readOptionalKey(canonicalRoot);
    return keyState === "invalid" ? recoveryRequiredPrivateState() : { status: "not-found" };
  }
  const keyState = await dependencies.readOptionalKey(canonicalRoot);
  if (keyState !== "valid") return recoveryRequiredPrivateState();
  if (proposalId && existing.journal.proposalId !== proposalId) return { status: "not-found" };
  if (existing.journal.phase === "ambiguous") {
    try {
      const claimState = await dependencies.retryClaimState(canonicalRoot);
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
  const tombstone = existing.journal.phase === "terminal"
    ? await dependencies.readTombstone(existing.journal.proposalId)
    : null;
  if (tombstone && !terminalTombstoneMatchesJournal(existing.journal, tombstone)) {
    return recoveryRequiredPrivateState();
  }
  const publicTombstone = tombstone && Date.parse(tombstone.expiresAt) > dependencies.now() ? tombstone : null;
  return publicStateFromJournal(existing.journal, publicTombstone);
}

export async function readPrivateRedemptionDeletionDisposition(
  dependencies: PrivateRedemptionLifecycleDependencies,
): Promise<CodexRedemptionDeletionDisposition> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await dependencies.verifyExistingRoot();
  } catch (error) {
    if (isEnoent(error)) return "safe";
    return unavailableOrRecoveryRequired(error);
  }
  try {
    const existing = await dependencies.readOptionalJournal(
      path.join(dependencies.rootPath, ACTIVE_JOURNAL_FILE),
      canonicalRoot,
    );
    if (existing.kind === "invalid") return "recovery-required";
    if (existing.kind === "journal") return "blocked";
    if (await dependencies.readOptionalKey(canonicalRoot) === "invalid") return "recovery-required";
    return await dependencies.retryClaimState(canonicalRoot) === "missing" ? "safe" : "recovery-required";
  } catch (error) {
    return unavailableOrRecoveryRequired(error);
  }
}

export async function readPrivateRedemptionReloginDisposition(
  dependencies: PrivateRedemptionLifecycleDependencies,
  evidence: RedemptionRecoveryEvidence,
): Promise<CodexRedemptionReloginDisposition> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await dependencies.verifyExistingRoot();
  } catch (error) {
    if (isEnoent(error)) return "unbound";
    return unavailableOrRecoveryRequired(error);
  }
  try {
    const existing = await dependencies.readOptionalJournal(
      path.join(dependencies.rootPath, ACTIVE_JOURNAL_FILE),
      canonicalRoot,
    );
    if (existing.kind === "invalid") return "recovery-required";
    if (existing.kind === "missing") {
      if (
        await dependencies.readOptionalKey(canonicalRoot) === "invalid" ||
        await dependencies.retryClaimState(canonicalRoot) !== "missing"
      ) return "recovery-required";
      return "unbound";
    }
    if (!redemptionStateTargetsProfileId(existing.journal, dependencies.profileId)) return "recovery-required";
    if (await dependencies.retryClaimState(canonicalRoot) === "invalid") return "recovery-required";
    const key = await dependencies.readDigestKey(canonicalRoot);
    const match = verifyRecoveryDigests(key, existing.journal, evidence, dependencies.profileId);
    return match.accountMatches && match.runtimeMatches && match.profileMatches !== false
      ? "matching-retained"
      : "mismatch";
  } catch (error) {
    return unavailableOrRecoveryRequired(error);
  }
}
