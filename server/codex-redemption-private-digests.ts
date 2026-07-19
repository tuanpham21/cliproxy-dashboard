import { createHmac, timingSafeEqual } from "node:crypto";

import type { RedemptionJournal } from "./codex-redemption-journal.js";
import type { CodexRuntimeIdentity } from "./codex-runtime-qualifier.js";

export type RedemptionRecoveryEvidence = {
  accountCheck: { email: string; plan: string };
  runtimeIdentity: CodexRuntimeIdentity;
};

export type RedemptionRecoveryEvidenceMatch = {
  accountMatches: boolean;
  runtimeMatches: boolean;
  profileMatches?: boolean;
};

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

export function accountCheckDigest(key: Buffer, proposalId: string, email: string, plan: string): string {
  return lengthPrefixedHmac(key, "cliproxy-dashboard/account-check/v1", [proposalId, email, plan]);
}

export function runtimePathDigest(key: Buffer, canonicalPath: string, codexStateRoot: string, codexSqliteRoot: string): string {
  return lengthPrefixedHmac(key, "cliproxy-dashboard/runtime-context/v3", [canonicalPath, codexStateRoot, codexSqliteRoot]);
}

export function profileRootRuntimeDigest(
  key: Buffer,
  profileId: string,
  runtimeIdentity: CodexRuntimeIdentity,
): string {
  return lengthPrefixedHmac(key, "cliproxy-dashboard/profile-root-runtime/v1", [
    profileId,
    runtimeIdentity.canonicalPath,
    runtimeIdentity.codexStateRoot,
    runtimeIdentity.codexSqliteRoot,
    runtimeIdentity.version,
    runtimeIdentity.fileIdentity,
    runtimeIdentity.schemaHash,
  ]);
}

function legacyRuntimePathDigest(key: Buffer, canonicalPath: string, codexStateRoot: string): string {
  return lengthPrefixedHmac(key, "cliproxy-dashboard/runtime-context/v2", [canonicalPath, codexStateRoot]);
}

export function equalDigest(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function verifyRecoveryDigests(
  key: Buffer,
  journal: RedemptionJournal,
  evidence: RedemptionRecoveryEvidence,
  expectedProfileId?: string,
): RedemptionRecoveryEvidenceMatch {
  const currentRuntimeDigest = runtimePathDigest(
    key,
    evidence.runtimeIdentity.canonicalPath,
    evidence.runtimeIdentity.codexStateRoot,
    evidence.runtimeIdentity.codexSqliteRoot,
  );
  const legacyRuntimeMatches =
    evidence.runtimeIdentity.codexSqliteRoot === evidence.runtimeIdentity.codexStateRoot &&
    equalDigest(
      journal.runtimeIdentity.canonicalPathDigest,
      legacyRuntimePathDigest(key, evidence.runtimeIdentity.canonicalPath, evidence.runtimeIdentity.codexStateRoot),
    );
  const profileMatches = journal.profileBinding === undefined
    ? expectedProfileId === undefined
    : journal.profileBinding.profileId === expectedProfileId && equalDigest(
      journal.profileBinding.profileRootRuntimeDigest,
      profileRootRuntimeDigest(key, journal.profileBinding.profileId, evidence.runtimeIdentity),
    );
  return {
    accountMatches: equalDigest(
      journal.accountCheckDigest,
      accountCheckDigest(key, journal.proposalId, evidence.accountCheck.email, evidence.accountCheck.plan),
    ),
    runtimeMatches:
      profileMatches &&
      (equalDigest(journal.runtimeIdentity.canonicalPathDigest, currentRuntimeDigest) || legacyRuntimeMatches) &&
      journal.runtimeIdentity.version === evidence.runtimeIdentity.version &&
      journal.runtimeIdentity.fileIdentity === evidence.runtimeIdentity.fileIdentity &&
      journal.runtimeIdentity.schemaHash === evidence.runtimeIdentity.schemaHash,
    ...(journal.profileBinding ? { profileMatches } : {}),
  };
}
