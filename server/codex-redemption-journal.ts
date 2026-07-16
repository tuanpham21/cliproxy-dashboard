import {
  isCodexRedemptionIdempotencyKey,
  isCodexRedemptionProposalId,
} from "../shared/codex-redemption-identifiers.js";

type JsonRecord = Record<string, unknown>;

export type RedemptionSelection =
  | { mode: "specific"; creditId: string }
  | { mode: "generic" };

export type PreparedRedemptionJournal = {
  schemaVersion: 1;
  phase: "prepared";
  proposalId: string;
  ownerNonce: string;
  owner: { pid: number; processStartIdentity: string };
  accountCheckDigest: string;
  idempotencyKey: string;
  selection: RedemptionSelection;
  runtimeIdentity: {
    canonicalPathDigest: string;
    version: string;
    fileIdentity: string;
    schemaHash: string;
  };
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function hasExactKeys(record: JsonRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function parseSelection(value: unknown): RedemptionSelection | null {
  if (!isRecord(value) || typeof value.mode !== "string") return null;
  if (value.mode === "generic" && hasExactKeys(value, ["mode"])) return { mode: "generic" };
  if (
    value.mode === "specific" &&
    hasExactKeys(value, ["mode", "creditId"]) &&
    typeof value.creditId === "string" &&
    value.creditId.length > 0 &&
    Buffer.byteLength(value.creditId, "utf8") <= 512
  ) {
    return { mode: "specific", creditId: value.creditId };
  }
  return null;
}

export function parsePreparedRedemptionJournal(value: unknown): PreparedRedemptionJournal | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion",
    "phase",
    "proposalId",
    "ownerNonce",
    "owner",
    "accountCheckDigest",
    "idempotencyKey",
    "selection",
    "runtimeIdentity",
    "createdAt",
    "expiresAt",
    "updatedAt",
  ])) return null;
  if (value.schemaVersion !== 1 || value.phase !== "prepared") return null;
  if (!isCodexRedemptionProposalId(value.proposalId)) return null;
  if (typeof value.ownerNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.ownerNonce)) return null;
  if (typeof value.accountCheckDigest !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.accountCheckDigest)) return null;
  if (!isCodexRedemptionIdempotencyKey(value.idempotencyKey)) return null;
    if (!isIso(value.createdAt) || !isIso(value.expiresAt) || !isIso(value.updatedAt)) return null;
    const createdAt = Date.parse(value.createdAt);
    const expiresAt = Date.parse(value.expiresAt);
    const updatedAt = Date.parse(value.updatedAt);
    if (
      expiresAt - createdAt !== 120_000 ||
      updatedAt < createdAt ||
      updatedAt > expiresAt
    ) return null;
  if (!isRecord(value.owner) || !hasExactKeys(value.owner, ["pid", "processStartIdentity"])) return null;
  if (!Number.isSafeInteger(value.owner.pid) || (value.owner.pid as number) <= 0) return null;
  if (typeof value.owner.processStartIdentity !== "string" || value.owner.processStartIdentity.length === 0) return null;
  const selection = parseSelection(value.selection);
  if (!selection) return null;
  if (!isRecord(value.runtimeIdentity) || !hasExactKeys(value.runtimeIdentity, [
    "canonicalPathDigest",
    "version",
    "fileIdentity",
    "schemaHash",
  ])) return null;
  if (
      typeof value.runtimeIdentity.canonicalPathDigest !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.runtimeIdentity.canonicalPathDigest) ||
      typeof value.runtimeIdentity.version !== "string" ||
      value.runtimeIdentity.version.length === 0 ||
      Buffer.byteLength(value.runtimeIdentity.version, "utf8") > 512 ||
      typeof value.runtimeIdentity.fileIdentity !== "string" ||
      value.runtimeIdentity.fileIdentity.length === 0 ||
      Buffer.byteLength(value.runtimeIdentity.fileIdentity, "utf8") > 512 ||
      typeof value.runtimeIdentity.schemaHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.runtimeIdentity.schemaHash)
  ) return null;
  return {
    schemaVersion: 1,
    phase: "prepared",
    proposalId: value.proposalId,
    ownerNonce: value.ownerNonce,
    owner: { pid: value.owner.pid as number, processStartIdentity: value.owner.processStartIdentity },
    accountCheckDigest: value.accountCheckDigest,
    idempotencyKey: value.idempotencyKey,
    selection,
    runtimeIdentity: {
      canonicalPathDigest: value.runtimeIdentity.canonicalPathDigest,
      version: value.runtimeIdentity.version,
      fileIdentity: value.runtimeIdentity.fileIdentity,
      schemaHash: value.runtimeIdentity.schemaHash,
    },
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    updatedAt: value.updatedAt,
  };
}
