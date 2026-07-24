import type { CodexResetCredit } from "./codex-account-gateway.js";

export type UsableCodexResetCredit = CodexResetCredit & { id: string };

export function selectCodexResetCredit(
  credits: readonly CodexResetCredit[],
  requestedCreditId: string | undefined,
  allowAutomaticSelection = false,
): UsableCodexResetCredit | null | undefined {
  const usable = credits.filter(
    (credit): credit is UsableCodexResetCredit => credit.availability === "available" && Boolean(credit.id),
  );
  if (requestedCreditId !== undefined) {
    const matches = usable.filter((credit) => credit.id === requestedCreditId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (usable.length === 0) return null;
  if (!allowAutomaticSelection) return undefined;
  return [...usable].sort((left, right) => {
    const leftExpiry = left.expiresAt ?? Number.POSITIVE_INFINITY;
    const rightExpiry = right.expiresAt ?? Number.POSITIVE_INFINITY;
    return leftExpiry - rightExpiry;
  }).find((candidate) => usable.filter((credit) => credit.id === candidate.id).length === 1);
}
