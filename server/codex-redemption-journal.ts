import {
  isCodexRedemptionIdempotencyKey,
  isCodexRedemptionProposalId,
} from "../shared/codex-redemption-identifiers.js";
import { terminalMessage } from "./codex-redemption-terminal-message.js";

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

export type RedemptionOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
export type RedemptionReconciliation = "pending" | "reconciled" | "unreconciled" | "availability-changed-unreconciled" | "not-required";
export type RedemptionJournalPhase = "prepared" | "dispatch-intent" | "dispatched" | "ambiguous" | "terminal";
type RedemptionJournalBase = Omit<PreparedRedemptionJournal, "phase">;
export type DispatchIntentRedemptionJournal = RedemptionJournalBase & { phase: "dispatch-intent"; dispatchAt: string };
export type DispatchedRedemptionJournal = RedemptionJournalBase & { phase: "dispatched"; dispatchAt: string };
export type AmbiguousRedemptionJournal = RedemptionJournalBase & { phase: "ambiguous"; dispatchAt: string };
export type TerminalRedemptionJournal = RedemptionJournalBase & {
  phase: "terminal";
  dispatchAt: string;
  terminalAt: string;
  outcome: RedemptionOutcome;
  reconciliation: RedemptionReconciliation;
  auditEventId: string;
};
export type RedemptionJournal =
  | PreparedRedemptionJournal
  | DispatchIntentRedemptionJournal
  | DispatchedRedemptionJournal
  | AmbiguousRedemptionJournal
  | TerminalRedemptionJournal;
export type RedemptionJournalPatch = Partial<{
  phase: RedemptionJournalPhase;
  dispatchAt: string | undefined;
  terminalAt: string;
  outcome: RedemptionOutcome;
  reconciliation: RedemptionReconciliation;
  auditEventId: string;
  updatedAt: string;
}>;

export type TerminalRedemptionTombstone = {
  schemaVersion: 1;
  proposalId: string;
  selectionMode: RedemptionSelection["mode"];
  outcome: RedemptionOutcome;
  reconciliation: Exclude<RedemptionReconciliation, "pending">;
  auditEventId: string;
  message: string;
  createdAt: string;
  expiresAt: string;
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

function validTerminalReconciliation(outcome: RedemptionOutcome, reconciliation: RedemptionReconciliation): boolean {
  if (reconciliation === "pending") return outcome !== "nothingToReset";
  if (outcome === "nothingToReset") return reconciliation === "not-required";
  if (outcome === "noCredit") return reconciliation === "reconciled" || reconciliation === "availability-changed-unreconciled";
  return reconciliation === "reconciled" || reconciliation === "unreconciled";
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

export function parseRedemptionJournal(value: unknown): RedemptionJournal | null {
  if (!isRecord(value) || typeof value.phase !== "string" || value.phase === "prepared") {
    return parsePreparedRedemptionJournal(value);
  }
  if (
    value.phase !== "dispatch-intent" &&
    value.phase !== "dispatched" &&
    value.phase !== "ambiguous" &&
    value.phase !== "terminal"
  ) return null;
  const base = parsePreparedRedemptionJournal({
    schemaVersion: value.schemaVersion,
    phase: "prepared",
    proposalId: value.proposalId,
    ownerNonce: value.ownerNonce,
    owner: value.owner,
    accountCheckDigest: value.accountCheckDigest,
    idempotencyKey: value.idempotencyKey,
    selection: value.selection,
    runtimeIdentity: value.runtimeIdentity,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    updatedAt: value.createdAt,
  });
  if (!base || !isIso(value.updatedAt) || Date.parse(value.updatedAt) < Date.parse(base.createdAt) || typeof value.dispatchAt !== "string" || !isIso(value.dispatchAt)) return null;
  const dispatchAt = value.dispatchAt;
  if (Date.parse(dispatchAt) < Date.parse(base.createdAt)) return null;
  const commonKeys = [
    "schemaVersion", "phase", "proposalId", "ownerNonce", "owner", "accountCheckDigest", "idempotencyKey",
    "selection", "runtimeIdentity", "createdAt", "expiresAt", "updatedAt", "dispatchAt",
  ];
  if (value.phase === "terminal") {
    if (!hasExactKeys(value, [...commonKeys, "terminalAt", "outcome", "reconciliation", "auditEventId"])) return null;
    if (typeof value.terminalAt !== "string" || !isIso(value.terminalAt) || Date.parse(value.terminalAt) < Date.parse(dispatchAt)) return null;
    if (value.outcome !== "reset" && value.outcome !== "alreadyRedeemed" && value.outcome !== "nothingToReset" && value.outcome !== "noCredit") return null;
    if (value.reconciliation !== "pending" && value.reconciliation !== "reconciled" && value.reconciliation !== "unreconciled" && value.reconciliation !== "availability-changed-unreconciled" && value.reconciliation !== "not-required") return null;
    if (!validTerminalReconciliation(value.outcome, value.reconciliation)) return null;
    if (typeof value.auditEventId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.auditEventId)) return null;
      return {
        ...base,
        phase: "terminal",
        dispatchAt,
        updatedAt: value.updatedAt,
        terminalAt: value.terminalAt,
      outcome: value.outcome,
      reconciliation: value.reconciliation,
      auditEventId: value.auditEventId,
    };
  }
  if (!hasExactKeys(value, commonKeys)) return null;
    return { ...base, phase: value.phase, dispatchAt, updatedAt: value.updatedAt };
}

export function parseTerminalRedemptionTombstone(value: unknown): TerminalRedemptionTombstone | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "schemaVersion", "proposalId", "selectionMode", "outcome", "reconciliation", "auditEventId", "message", "createdAt", "expiresAt",
  ])) return null;
  if (value.schemaVersion !== 1 || !isCodexRedemptionProposalId(value.proposalId)) return null;
  if (value.selectionMode !== "specific" && value.selectionMode !== "generic") return null;
  if (value.outcome !== "reset" && value.outcome !== "alreadyRedeemed" && value.outcome !== "nothingToReset" && value.outcome !== "noCredit") return null;
  if (value.reconciliation !== "reconciled" && value.reconciliation !== "unreconciled" && value.reconciliation !== "availability-changed-unreconciled" && value.reconciliation !== "not-required") return null;
  if (!validTerminalReconciliation(value.outcome, value.reconciliation)) return null;
  if (typeof value.auditEventId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.auditEventId)) return null;
  if (typeof value.message !== "string" || value.message.length === 0 || Buffer.byteLength(value.message, "utf8") > 512) return null;
  if (!isIso(value.createdAt) || !isIso(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) return null;
  return value as TerminalRedemptionTombstone;
}

export function terminalTombstoneMatchesJournal(
  journal: RedemptionJournal,
  tombstone: TerminalRedemptionTombstone,
): boolean {
  return journal.phase === "terminal" &&
    journal.reconciliation !== "pending" &&
    journal.proposalId === tombstone.proposalId &&
    journal.selection.mode === tombstone.selectionMode &&
    journal.outcome === tombstone.outcome &&
    journal.reconciliation === tombstone.reconciliation &&
    journal.auditEventId === tombstone.auditEventId &&
    tombstone.message === terminalMessage(journal.outcome, journal.selection.mode, journal.reconciliation) &&
      Date.parse(tombstone.createdAt) >= Date.parse(journal.terminalAt) &&
    Date.parse(tombstone.expiresAt) > Date.parse(tombstone.createdAt);
}
