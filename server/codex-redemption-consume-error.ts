export type ConsumeErrorCode =
  | "codex_account_changed"
  | "codex_reset_availability_changed"
  | "codex_session_changed"
  | "codex_proposal_expired"
  | "redemption-recovery-required";

export class CodexRedemptionConsumeError extends Error {
  readonly code: ConsumeErrorCode;

  constructor(code: ConsumeErrorCode) {
    super(code);
    this.name = "CodexRedemptionConsumeError";
    this.code = code;
  }
}
