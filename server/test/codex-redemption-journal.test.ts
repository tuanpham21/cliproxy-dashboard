import { describe, expect, it } from "vitest";

import {
  parsePreparedRedemptionJournal,
  parseRedemptionJournal,
  parseTerminalRedemptionTombstone,
} from "../codex-redemption-journal.js";

const validJournal = {
  schemaVersion: 1,
  phase: "prepared",
  proposalId: "p".repeat(43),
  ownerNonce: "n".repeat(43),
  owner: { pid: 1234, processStartIdentity: "boot:start" },
  accountCheckDigest: "d".repeat(43),
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
  selection: { mode: "generic" },
  runtimeIdentity: {
    canonicalPathDigest: "r".repeat(43),
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4",
    schemaHash: "a".repeat(64),
  },
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-16T12:02:00.000Z",
  updatedAt: "2026-07-16T12:00:00.000Z",
};

describe("prepared redemption journal codec", () => {
  it("requires exact opaque proposal and UUID idempotency identifiers", () => {
    expect(parsePreparedRedemptionJournal(validJournal)).not.toBeNull();
    expect(parsePreparedRedemptionJournal({ ...validJournal, proposalId: "p".repeat(42) })).toBeNull();
    expect(parsePreparedRedemptionJournal({ ...validJournal, proposalId: "p".repeat(44) })).toBeNull();
    expect(parsePreparedRedemptionJournal({ ...validJournal, idempotencyKey: "" })).toBeNull();
    expect(parsePreparedRedemptionJournal({ ...validJournal, idempotencyKey: "client-key" })).toBeNull();
  });

  it("rejects impossible prepared timestamp windows", () => {
    expect(parsePreparedRedemptionJournal({
      ...validJournal,
      expiresAt: "2026-07-16T12:01:59.999Z",
    })).toBeNull();
    expect(parsePreparedRedemptionJournal({
      ...validJournal,
      updatedAt: "2026-07-16T11:59:59.999Z",
    })).toBeNull();
    expect(parsePreparedRedemptionJournal({
      ...validJournal,
      updatedAt: "2026-07-16T12:02:00.001Z",
    })).toBeNull();
  });

  it("rejects empty or oversized runtime identity evidence", () => {
    expect(parsePreparedRedemptionJournal({
      ...validJournal,
      runtimeIdentity: { ...validJournal.runtimeIdentity, version: "" },
    })).toBeNull();
    expect(parsePreparedRedemptionJournal({
      ...validJournal,
      runtimeIdentity: { ...validJournal.runtimeIdentity, fileIdentity: "" },
    })).toBeNull();
    expect(parsePreparedRedemptionJournal({
      ...validJournal,
      runtimeIdentity: { ...validJournal.runtimeIdentity, version: "v".repeat(513) },
    })).toBeNull();
  });

  it("accepts strict dispatch and terminal records plus non-secret tombstones", () => {
    const dispatched = {
      ...validJournal,
      phase: "dispatched",
      dispatchAt: "2026-07-16T12:00:01.000Z",
      updatedAt: "2026-07-16T12:00:02.000Z",
    };
    expect(parseRedemptionJournal(dispatched)).toMatchObject({ phase: "dispatched" });
    expect(parseRedemptionJournal({
      ...dispatched,
      phase: "terminal",
      terminalAt: "2026-07-16T12:00:03.000Z",
      outcome: "reset",
      reconciliation: "reconciled",
      auditEventId: "a".repeat(43),
      updatedAt: "2026-07-16T12:00:03.000Z",
    })).toMatchObject({ phase: "terminal", outcome: "reset" });
    expect(parseTerminalRedemptionTombstone({
      schemaVersion: 1,
      proposalId: validJournal.proposalId,
      selectionMode: "generic",
      outcome: "nothingToReset",
      reconciliation: "not-required",
      auditEventId: "a".repeat(43),
      message: "No eligible usage limit needs a reset right now. No reset was applied.",
      createdAt: "2026-07-16T12:00:03.000Z",
      expiresAt: "2026-07-16T12:10:03.000Z",
    })).not.toBeNull();
  });
});
