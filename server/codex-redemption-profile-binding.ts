import { isRegistryProfileId } from "./codex-login-profile-registry-migration.js";
import type {
  RedemptionJournal,
  TerminalRedemptionTombstone,
} from "./codex-redemption-journal.js";

export type RedemptionProfileBinding = {
  profileId: string;
  profileRootRuntimeDigest: string;
};

export function parseRedemptionProfileBinding(value: unknown): RedemptionProfileBinding | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;
  if (Object.keys(binding).sort().join(",") !== "profileId,profileRootRuntimeDigest") return null;
  if (typeof binding.profileId !== "string" || !isRegistryProfileId(binding.profileId)) return null;
  if (
    typeof binding.profileRootRuntimeDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(binding.profileRootRuntimeDigest)
  ) return null;
  return {
    profileId: binding.profileId,
    profileRootRuntimeDigest: binding.profileRootRuntimeDigest,
  };
}

type ParsedVersionedRedemptionProfileBinding =
  | Readonly<{
      expectedKeys: readonly [];
      profileBinding?: undefined;
    }>
  | Readonly<{
      expectedKeys: readonly ["profileBinding"];
      profileBinding: RedemptionProfileBinding;
    }>;

export function parseVersionedRedemptionProfileBinding(
  value: { schemaVersion?: unknown; profileBinding?: unknown },
): ParsedVersionedRedemptionProfileBinding | null {
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2) return null;
  const hasProfileBinding = Object.hasOwn(value, "profileBinding");
  if (value.schemaVersion === 1) {
    return hasProfileBinding ? null : { expectedKeys: [] };
  }
  if (!hasProfileBinding) return null;
  const profileBinding = parseRedemptionProfileBinding(value.profileBinding);
  return profileBinding ? { expectedKeys: ["profileBinding"], profileBinding } : null;
}

export function redemptionProfileBindingsEqual(
  left?: RedemptionProfileBinding,
  right?: RedemptionProfileBinding,
): boolean {
  return left === undefined || right === undefined
    ? left === right
    : left.profileId === right.profileId && left.profileRootRuntimeDigest === right.profileRootRuntimeDigest;
}

export function redemptionStateTargetsProfileId(
  value: { schemaVersion: 1 | 2; profileBinding?: RedemptionProfileBinding },
  profileId?: string,
): boolean {
  return profileId === undefined
    ? value.schemaVersion === 1 && value.profileBinding === undefined
    : value.schemaVersion === 2 && value.profileBinding?.profileId === profileId;
}

export function bindTerminalTombstoneToScope(
  tombstone: TerminalRedemptionTombstone,
  journal: RedemptionJournal,
  profileId?: string,
): TerminalRedemptionTombstone | null {
  if (profileId === undefined) {
    return redemptionStateTargetsProfileId(tombstone) ? tombstone : null;
  }
  if (
    journal.phase !== "terminal" ||
    journal.proposalId !== tombstone.proposalId ||
    !redemptionStateTargetsProfileId(journal, profileId) ||
    !journal.profileBinding
  ) return null;
  const bound = tombstone.schemaVersion === 1 && tombstone.profileBinding === undefined
    ? { ...tombstone, schemaVersion: 2 as const, profileBinding: journal.profileBinding }
    : tombstone;
  return redemptionStateTargetsProfileId(bound, profileId) &&
    redemptionProfileBindingsEqual(bound.profileBinding, journal.profileBinding)
    ? bound
    : null;
}
