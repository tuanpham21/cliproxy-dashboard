export type CodexRedemptionRecoveryErrorCode =
  | "codex_recovery_account_mismatch"
  | "codex_recovery_session_changed"
  | "redemption-recovery-required";

export class CodexRedemptionRecoveryError extends Error {
  readonly code: CodexRedemptionRecoveryErrorCode;

  constructor(code: CodexRedemptionRecoveryErrorCode) {
    super(code);
    this.name = "CodexRedemptionRecoveryError";
    this.code = code;
  }
}
