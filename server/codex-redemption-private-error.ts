export type CodexRedemptionPrivateStateErrorCode =
  | "redemption-private-state-unavailable"
  | "redemption-recovery-required"
  | "redemption-proposal-active"
  | "redemption-proposal-not-found"
  | "redemption-proposal-owner-mismatch";

export class CodexRedemptionPrivateStateError extends Error {
  readonly code: CodexRedemptionPrivateStateErrorCode;

  constructor(code: CodexRedemptionPrivateStateErrorCode) {
    const message =
      code === "redemption-private-state-unavailable"
        ? "Private reset redemption state is unavailable on this host."
        : code === "redemption-recovery-required"
          ? "Reset redemption recovery state requires local repair."
          : code === "redemption-proposal-active"
            ? "Another reset redemption proposal is already active."
            : code === "redemption-proposal-not-found"
              ? "Reset redemption proposal was not found."
              : "Reset redemption proposal ownership did not match.";
    super(message);
    this.name = "CodexRedemptionPrivateStateError";
    this.code = code;
  }
}
