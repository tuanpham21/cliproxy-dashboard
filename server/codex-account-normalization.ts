import type { CodexAccountUsageWindow } from "../shared/types.js";
import type { CodexRateLimitWindow } from "./codex-account-gateway.js";

export function codexSecondsToIso(value: number | null): string | null {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function normalizeCodexUsageWindow(
  window: CodexRateLimitWindow | null,
): CodexAccountUsageWindow | null {
  if (!window) return null;
  return {
    usedPercent:
      Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent <= 100
        ? window.usedPercent
        : null,
    durationMinutes:
      window.windowMinutes !== null && Number.isSafeInteger(window.windowMinutes) && window.windowMinutes >= 0
        ? window.windowMinutes
        : null,
    resetsAt: codexSecondsToIso(window.resetsAt),
  };
}

export function normalizeCodexAvailableCount(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}
