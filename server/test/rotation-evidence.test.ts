import { describe, expect, it } from "vitest";

import { parseQuotaResponseEvidence } from "../quota-log-updates.js";

describe("duration-bound quota evidence", () => {
  const observedAt = Date.parse("2026-07-15T00:00:00.000Z");

  it("recognizes weekly-only Primary and reversed slots by duration", () => {
    const primaryWeekly = parseQuotaResponseEvidence([
      "X-Codex-Primary-Used-Percent: 18.25",
      "X-Codex-Primary-Window-Minutes: 10080",
      "X-Codex-Primary-Reset-After-Seconds: 604800",
    ], observedAt, "response-1", "fp-a");
    expect(primaryWeekly.weekly).toMatchObject({ usedPercent: 18.25, durationMinutes: 10080, windowKind: "weekly", providerSlot: "primary", credentialFingerprint: "fp-a" });
    expect(primaryWeekly.weekly?.migrationOnly).toBe(false);

    const secondaryFiveHour = parseQuotaResponseEvidence([
      "X-Codex-Secondary-Used-Percent: 4.5",
      "X-Codex-Secondary-Window-Minutes: 300",
      "X-Codex-Secondary-Reset-After-Seconds: 18000",
    ], observedAt, "response-2", "fp-b");
    expect(secondaryFiveHour.fiveHour).toMatchObject({ usedPercent: 4.5, durationMinutes: 300, windowKind: "five-hour", providerSlot: "secondary" });
    expect(secondaryFiveHour.weekly).toBeUndefined();

    const normalOrder = parseQuotaResponseEvidence([
      "X-Codex-Primary-Used-Percent: 9",
      "X-Codex-Primary-Window-Minutes: 300",
      "X-Codex-Secondary-Used-Percent: 27.125",
      "X-Codex-Secondary-Window-Minutes: 10080",
    ], observedAt, "response-3", "fp-c");
    expect(normalOrder.fiveHour).toMatchObject({ usedPercent: 9, providerSlot: "primary" });
    expect(normalOrder.weekly).toMatchObject({ usedPercent: 27.125, providerSlot: "secondary" });
  });

  it("quarantines missing, malformed, and unknown duration", () => {
    for (const duration of [undefined, "10080x", "0", "abc", "1440"]) {
      const lines = [
        "X-Codex-Primary-Used-Percent: 20",
        ...(duration === undefined ? [] : [`X-Codex-Primary-Window-Minutes: ${duration}`]),
      ];
      const parsed = parseQuotaResponseEvidence(lines, observedAt, `response-${String(duration)}`, "fp-a");
      expect(parsed.weekly).toBeUndefined();
      expect(parsed.legacyPrimary5h?.migrationOnly).toBe(true);
    }
  });

  it("keeps exact raw precision and stable evidence id", () => {
    const lines = [
      "X-Codex-Primary-Used-Percent: 19.875",
      "X-Codex-Primary-Window-Minutes: 10080",
    ];
    const first = parseQuotaResponseEvidence(lines, observedAt, "response-stable", "fp-a");
    const second = parseQuotaResponseEvidence(lines, observedAt, "response-stable", "fp-a");
    expect(first.weekly?.usedPercent).toBe(19.875);
    expect(first.weekly?.rawUsedPercent).toBe(19.875);
    expect(first.weekly?.evidenceId).toBe(second.weekly?.evidenceId);
  });
});
