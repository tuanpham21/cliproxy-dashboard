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

function creditMarkup(credit: CodexAccountResetCredit, index: number): string {
  const title = credit.title ?? `Reset detail ${index + 1}`;
  const status = credit.availability === "available" ? "Available" : "Unavailable diagnostic";
  const expiry =
    credit.availability === "malformed"
      ? "Expiry unavailable"
      : credit.expiresAt
        ? `Expires ${formatToGmt7(credit.expiresAt)}`
        : "Does not expire";
  return [
    `<li class="codex-credit codex-credit-${credit.availability}">`,
    `<div class="codex-credit-title"><strong>${escapeHtml(title)}</strong><span class="badge neutral">${status}</span></div>`,
    credit.description ? `<p>${escapeHtml(credit.description)}</p>` : "",
    `<div class="muted small">${escapeHtml(expiry)}</div>`,
    "</li>",
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
    '<p class="codex-workspace-warning">Email and plan help identify the account but do not prove which ChatGPT workspace owns a reset.</p>',
    resetCredits
      ? `<div class="codex-reset-summary"><strong>${resetCredits.availableCount}</strong> earned usage limit reset${resetCredits.availableCount === 1 ? "" : "s"}</div>`
      : "",
    credits.length ? `<ul class="codex-credit-list" aria-label="Usage limit reset details">${credits.map(creditMarkup).join("")}</ul>` : "",
      generic
        ? '<div class="codex-generic-reset"><strong>Use a reset</strong><span>OpenAI will select the reset because detailed credit information is unavailable.</span></div>'
        : "",
      view.state === "usage-ready-resets-available"
        ? '<p class="muted small codex-redemption-disabled">Redemption remains disabled.</p>'
        : "",
  ].join("");
}

export function renderCodexAppAccount(view: CodexAccountUsageView): string {
  const messageAttributes =
    view.state === "read-failed"
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
