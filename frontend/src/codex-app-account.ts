import type {
  CodexRedemptionCurrentView,
} from "../../shared/codex-account-types";
import type {
  CodexAccountResetCredit,
  CodexAccountUsageView,
  CodexAccountUsageWindow,
} from "../../shared/types";
import { escapeHtml, formatToGmt7 } from "./format";

export function codexLoadingView(): CodexAccountUsageView {
  return {
    state: "loading",
    errorCode: null,
    message: "Loading Codex app usage…",
    runtime: { status: "unknown", version: null },
    account: null,
    observedAt: null,
    usage: null,
    resetCredits: null,
  };
}

function windowMarkup(label: string, window: CodexAccountUsageWindow | null): string {
  if (!window) {
    return `<div class="codex-usage-window"><strong>${label}</strong><span class="muted">Not reported</span></div>`;
  }
  const usage = window.usedPercent === null ? "Unknown usage" : `${window.usedPercent}% used`;
  const duration =
    window.durationMinutes === null
      ? "Unknown duration"
      : `${new Intl.NumberFormat("en-US").format(window.durationMinutes)} minutes`;
  const reset = window.resetsAt ? `Resets ${escapeHtml(formatToGmt7(window.resetsAt))}` : "Reset time unavailable";
  return [
    '<div class="codex-usage-window">',
    `<strong>${label}</strong>`,
    `<span>${escapeHtml(usage)}</span>`,
    `<span class="muted">${escapeHtml(duration)}</span>`,
    `<span class="muted">${reset}</span>`,
    "</div>",
  ].join("");
}

function creditMarkup(credit: CodexAccountResetCredit, index: number, checked: boolean): string {
  const title = credit.title ?? `Reset detail ${index + 1}`;
  const selectable = credit.availability === "available" && Boolean(credit.id);
  const status = selectable ? "Available" : "Unavailable";
  const expiry =
    credit.availability === "malformed"
      ? "Expiry unavailable"
      : credit.expiresAt
        ? `Expires ${formatToGmt7(credit.expiresAt)}`
        : "Does not expire";
  return [
    `<label class="codex-credit codex-credit-${credit.availability}">`,
    `<input type="radio" name="codex-reset-selection" value="${escapeHtml(credit.id ?? `unavailable-${index}`)}"`,
    ` data-codex-reset-credit${selectable ? "" : " disabled"}${checked ? " checked" : ""}`,
    ` aria-describedby="codex-credit-description-${index} codex-credit-expiry-${index}">`,
    `<span class="codex-credit-title"><strong>${escapeHtml(title)}</strong><span class="badge neutral">${status}</span></span>`,
    `<span id="codex-credit-description-${index}">${credit.description ? escapeHtml(credit.description) : "No description provided."}</span>`,
    `<span id="codex-credit-expiry-${index}" class="muted small">${escapeHtml(expiry)}</span>`,
    "</label>",
  ].join("");
}

function redemptionControls(view: CodexAccountUsageView): string {
    if (view.usageStale) return "";
    if (view.activeRedemption && view.activeRedemption.status !== "not-found") return "";
  const resetCredits = view.resetCredits;
  if (view.state !== "usage-ready-resets-available" || !resetCredits || resetCredits.availableCount <= 0) return "";
  const firstSelectable = resetCredits.credits.findIndex(
    (credit) => credit.availability === "available" && Boolean(credit.id),
  );
  const options = resetCredits.selectionMode === "detailed"
    ? resetCredits.credits.map((credit, index) => creditMarkup(credit, index, index === firstSelectable)).join("")
    : [
        '<label class="codex-credit codex-generic-reset">',
        '<input type="radio" name="codex-reset-selection" value="generic" data-codex-reset-generic checked>',
        '<span class="codex-credit-title"><strong>Use a reset</strong><span class="badge neutral">Available</span></span>',
        '<span>OpenAI will select the reset because detailed credit information is unavailable.</span>',
        "</label>",
        ...resetCredits.credits.map((credit, index) => creditMarkup(credit, index, false)),
      ].join("");
  return [
    '<form class="codex-redemption-form" data-codex-redemption-form>',
    '<fieldset class="codex-credit-list"><legend>Choose a usage limit reset</legend>',
    options,
    "</fieldset>",
    '<p class="codex-workspace-warning">If this email can switch between Personal, Business, Enterprise, or another workspace, do not continue. This dashboard cannot verify which workspace owns the reset.</p>',
    '<label class="codex-redemption-attestation">',
    '<input type="checkbox" data-codex-workspace-attestation>',
    '<span>I confirm this Codex app account uses one ChatGPT workspace for Codex, and this is the workspace whose earned reset I intend to use.</span>',
    "</label>",
    '<button type="submit" class="primary" data-codex-redemption-prepare disabled>Review reset</button>',
    "</form>",
  ].join("");
}

function recoveryMarkup(state: Extract<CodexRedemptionCurrentView, { status: "ambiguous" | "processing" }>): string {
  const mode = state.selectionMode === "specific" ? "Specific reset" : "OpenAI-selected reset";
  const retrying = state.status === "processing" && state.phase === "retrying";
  return [
    '<section class="codex-redemption-recovery" aria-labelledby="codex-redemption-recovery-title">',
    '<h3 id="codex-redemption-recovery-title">Redemption recovery</h3>',
    `<p role="${state.status === "ambiguous" ? "alert" : "status"}">${retrying
      ? "Retrying the same redemption. New redemptions remain blocked."
      : "A reset request was sent, but its outcome was not confirmed. New redemptions are blocked until this same attempt is resolved."}</p>`,
    '<dl class="codex-redemption-recovery-details">',
    `<div><dt>Attempt</dt><dd>${escapeHtml(state.proposalId)}</dd></div>`,
    `<div><dt>Mode</dt><dd>${escapeHtml(mode)}</dd></div>`,
    `<div><dt>Sent</dt><dd>${escapeHtml(formatToGmt7(state.dispatchAt))}</dd></div>`,
    "</dl>",
    state.status === "ambiguous"
      ? `<button type="button" class="secondary" data-codex-redemption-retry data-proposal-id="${escapeHtml(state.proposalId)}">Retry same redemption</button>`
      : "",
    "</section>",
  ].join("");
}

function readyMarkup(view: CodexAccountUsageView): string {
  const account = view.account;
  const resetCredits = view.resetCredits;
  const credits = resetCredits?.credits ?? [];
  const generic = resetCredits?.selectionMode === "generic";
  return [
    '<div class="codex-account-grid">',
    '<div class="codex-account-identity">',
    '<div class="label">Codex App Account Check</div>',
    `<div class="value mono">${escapeHtml(account?.email ?? "Email unavailable")}</div>`,
    `<div class="muted">Plan: ${escapeHtml(account?.plan ?? "unknown")}</div>`,
    view.runtime.version ? `<div class="muted small">Runtime: ${escapeHtml(view.runtime.version)}</div>` : "",
    "</div>",
    '<div class="codex-usage-windows">',
    windowMarkup("Primary usage window", view.usage?.primary ?? null),
    windowMarkup("Secondary usage window", view.usage?.secondary ?? null),
    "</div>",
    "</div>",
    view.observedAt ? `<div class="muted small codex-observed">Observed ${escapeHtml(formatToGmt7(view.observedAt))}</div>` : "",
    view.usageStale ? '<p class="codex-redemption-recovery" role="alert">Last read before redemption — no longer current</p>' : "",
    '<p class="codex-workspace-warning">Email and plan help identify the account but do not prove which ChatGPT workspace owns a reset.</p>',
    resetCredits
      ? `<div class="codex-reset-summary"><strong>${resetCredits.availableCount}</strong> earned usage limit reset${resetCredits.availableCount === 1 ? "" : "s"}</div>`
      : "",
      view.state !== "usage-ready-resets-available" && credits.length
        ? `<div class="codex-credit-list" aria-label="Usage limit reset details">${credits.map((credit, index) => creditMarkup(credit, index, false)).join("")}</div>`
        : "",
      generic && view.state !== "usage-ready-resets-available"
        ? '<div class="codex-generic-reset"><strong>Use a reset</strong><span>OpenAI will select the reset because detailed credit information is unavailable.</span></div>'
        : "",
      view.activeRedemption?.status === "recovery-required" || view.activeRedemption?.status === "unavailable"
        ? `<p class="codex-redemption-recovery" role="alert">${escapeHtml(view.activeRedemption.message)}</p>`
        : view.activeRedemption?.status === "ambiguous"
          ? recoveryMarkup(view.activeRedemption)
          : view.activeRedemption?.status === "processing"
            ? recoveryMarkup(view.activeRedemption)
            : view.activeRedemption?.status === "terminal"
              ? `<p class="codex-redemption-active" role="status">${escapeHtml(view.activeRedemption.message)}</p>`
              : view.activeRedemption?.status === "prepared"
                ? '<p class="codex-redemption-active" role="status">Another reset confirmation is active. Return to its original dashboard tab or wait for expiry.</p>'
                : redemptionControls(view),
  ].join("");
}

export function renderCodexAppAccount(view: CodexAccountUsageView): string {
  const messageAttributes =
    view.state === "read-failed" || view.state === "runtime-incompatible"
      ? ' role="alert" aria-atomic="true"'
      : ' role="status" aria-live="polite" aria-atomic="true"';
  const ready =
    view.state === "usage-ready-no-resets" ||
    view.state === "usage-ready-resets-available" ||
    view.state === "identity-incomplete";
  return [
    `<div class="codex-account-state codex-state-${view.state}">`,
    `<p class="codex-state-message"${messageAttributes}>${escapeHtml(view.message)}</p>`,
    ready ? readyMarkup(view) : "",
    "</div>",
  ].join("");
}
