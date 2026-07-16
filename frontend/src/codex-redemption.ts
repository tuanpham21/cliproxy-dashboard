import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
  CodexRedemptionUsageSnapshot,
} from "../../shared/codex-account-types";
import {
  cancelCodexRedemption,
  consumeCodexRedemption,
  DashboardApiError,
  prepareCodexRedemption,
  readCodexRedemptionState,
} from "./api";
import { formatToGmt7 } from "./format";

type RedemptionApi = {
  prepare: typeof prepareCodexRedemption;
  state: typeof readCodexRedemptionState;
  cancel: typeof cancelCodexRedemption;
  consume: typeof consumeCodexRedemption;
};

export type CodexRedemptionControllerOptions = {
  panel: HTMLElement;
  dialog: HTMLDialogElement;
  pageStatus: HTMLElement;
  focusFallback: HTMLElement;
  refreshAccount: () => Promise<void>;
  applyAccountUsage?: (snapshot: CodexRedemptionUsageSnapshot) => void;
  markAccountUsageStale?: (message: string) => void;
  api?: RedemptionApi;
  now?: () => number;
};

const EXPIRY_MESSAGE = "Confirmation expired. Account details and reset availability were refreshed. Review them and try again.";
const SESSION_PROPOSAL_KEY = "cliproxy-dashboard/codex-reset-redemption/proposal";

function byId<T extends HTMLElement>(root: ParentNode, id: string): T {
  const element = root.querySelector<T>(`#${id}`);
  if (!element) throw new Error(`Missing Codex redemption element: ${id}`);
  return element;
}

function usageText(proposal: CodexRedemptionProposalView): string {
  const windowText = (label: string, usedPercent: number | null | undefined) =>
    `${label} ${usedPercent === null || usedPercent === undefined ? "usage unavailable" : `${usedPercent}% used`}`;
  return `${windowText("Primary", proposal.usage.primary?.usedPercent)}; ${windowText("Secondary", proposal.usage.secondary?.usedPercent)}.`;
}

function confirmationText(proposal: CodexRedemptionProposalView): string {
  if (proposal.selection.mode === "generic") {
    return `This will use 1 of ${proposal.availableCount} earned resets for ${proposal.account.email} on the ${proposal.account.plan} plan. OpenAI will select the reset and decide which eligible usage limits reset.`;
  }
  const expiry = proposal.selection.expiresAt
    ? `It expires ${formatToGmt7(proposal.selection.expiresAt)}.`
    : "It does not expire.";
  return `This will use “${proposal.selection.title}” for ${proposal.account.email} on the ${proposal.account.plan} plan. ${expiry} OpenAI decides which eligible usage limits reset.`;
}

function countdownText(expiresAt: string, now: number): string {
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, "0");
  return `Confirmation expires in ${minutes}:${seconds}`;
}

function storedProposalId(): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_PROPOSAL_KEY) ?? "null") as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    if (typeof (value as { proposalId?: unknown }).proposalId !== "string") return null;
    const proposalId = (value as { proposalId: string }).proposalId;
    return /^[A-Za-z0-9_-]{43}$/.test(proposalId) ? proposalId : null;
  } catch {
    return null;
  }
}

export function setupCodexRedemption(options: CodexRedemptionControllerOptions): {
  close(): void;
  resume(state: CodexRedemptionCurrentView | undefined): void;
} {
  const api = options.api ?? {
    prepare: prepareCodexRedemption,
    state: readCodexRedemptionState,
    cancel: cancelCodexRedemption,
    consume: consumeCodexRedemption,
  };
  const now = options.now ?? Date.now;
  const description = byId<HTMLDivElement>(options.dialog, "codex-redemption-dialog-description");
  const countdown = byId<HTMLElement>(options.dialog, "codex-redemption-countdown");
  const thresholdStatus = byId<HTMLElement>(options.dialog, "codex-redemption-threshold-status");
  const dialogError = byId<HTMLElement>(options.dialog, "codex-redemption-dialog-error");
  const cancelButton = byId<HTMLButtonElement>(options.dialog, "codex-redemption-cancel");
  const confirmButton = byId<HTMLButtonElement>(options.dialog, "codex-redemption-confirm");
  let active: CodexRedemptionProposalView | null = null;
  let opener: HTMLElement | null = null;
  let countdownTimer: number | null = null;
  let pollTimer: number | null = null;
  let pollInFlight = false;
  let pollingBlocked = false;
  let finishing = false;
  let consuming = false;
  let postDispatch = false;
  let consumeDeadlineTimer: number | null = null;
  let lastRemainingSeconds: number | null = null;
  let pendingProposalId = storedProposalId();

  const setPageStatus = (message: string, isError = false) => {
    options.pageStatus.setAttribute("role", isError ? "alert" : "status");
    options.pageStatus.textContent = message;
  };

  const stopPolling = () => {
    if (pollTimer !== null) window.clearInterval(pollTimer);
    pollTimer = null;
  };

  const stopTimers = () => {
    if (countdownTimer !== null) window.clearInterval(countdownTimer);
    countdownTimer = null;
    stopPolling();
  };

  const stopCountdown = () => {
    if (countdownTimer !== null) window.clearInterval(countdownTimer);
    countdownTimer = null;
  };

  const resetPanelAttestation = (keepOpenerFocusable: boolean) => {
    const checkbox = options.panel.querySelector<HTMLInputElement>("[data-codex-workspace-attestation]");
    const button = options.panel.querySelector<HTMLButtonElement>("[data-codex-redemption-prepare]");
    if (checkbox) checkbox.checked = false;
    if (button) {
      button.disabled = !keepOpenerFocusable;
      if (keepOpenerFocusable) {
        button.setAttribute("aria-disabled", "true");
        button.addEventListener("blur", () => {
          button.disabled = true;
          button.removeAttribute("aria-disabled");
        }, { once: true });
      } else {
        button.removeAttribute("aria-disabled");
      }
      button.removeAttribute("aria-busy");
    }
  };

  const finish = async (message: string, refresh: boolean) => {
    if (finishing) return;
    finishing = true;
    stopTimers();
    if (consumeDeadlineTimer !== null) window.clearTimeout(consumeDeadlineTimer);
    consumeDeadlineTimer = null;
    if (options.dialog.open) options.dialog.close();
    resetPanelAttestation(!refresh);
    active = null;
    pendingProposalId = null;
    consuming = false;
    postDispatch = false;
    options.dialog.removeAttribute("aria-busy");
    cancelButton.textContent = "Cancel";
    try {
      sessionStorage.removeItem(SESSION_PROPOSAL_KEY);
    } catch {
      // Session storage is optional; server expiry remains authoritative.
    }
    dialogError.hidden = true;
    setPageStatus(message);
    if (refresh) await options.refreshAccount().catch(() => {});
    const focusTarget = opener?.isConnected ? opener : options.focusFallback;
    focusTarget.focus();
    opener = null;
    finishing = false;
  };

  const poll = async () => {
    const proposal = active;
    const proposalId = proposal?.proposalId ?? pendingProposalId;
    if (!proposalId || pollingBlocked || pollInFlight || finishing) return;
    pollInFlight = true;
    try {
      const state = await api.state(proposalId);
      if (proposal) {
        if (active !== proposal || state.status === "prepared" || state.status === "processing") return;
        if (state.status === "terminal") {
          await finish(state.message, true);
        } else if (state.status === "ambiguous") {
          postDispatch = true;
          closePostDispatch("Couldn’t confirm whether redemption completed. Retry uses the same attempt and cannot repeat a completed redemption.");
        } else {
          const expired = now() >= Date.parse(proposal.expiresAt);
          const message = state.status === "recovery-required" || state.status === "unavailable"
            ? state.message
            : expired
              ? EXPIRY_MESSAGE
              : "Confirmation ended. Account details and reset availability were refreshed. Review them and try again.";
          await finish(message, true);
        }
        return;
      }
      if (pendingProposalId !== proposalId || state.status === "prepared" || state.status === "processing") return;
      pendingProposalId = null;
      stopTimers();
      try {
        sessionStorage.removeItem(SESSION_PROPOSAL_KEY);
      } catch {
        // Session storage is optional; server state remains authoritative.
      }
      if (state.status === "terminal") {
        if (state.accountUsage) options.applyAccountUsage?.(state.accountUsage);
        else if (state.reconciliation === "unreconciled" || state.reconciliation === "availability-changed-unreconciled") {
          options.markAccountUsageStale?.(state.message);
        }
        setPageStatus(state.message);
        if (!state.accountUsage && state.reconciliation !== "unreconciled" && state.reconciliation !== "availability-changed-unreconciled") {
          await options.refreshAccount().catch(() => {});
        }
      } else if (state.status === "ambiguous") {
        setPageStatus("Couldn’t confirm whether redemption completed. Retry uses the same attempt and cannot repeat a completed redemption.", true);
      } else {
        const unavailable = state.status === "recovery-required" || state.status === "unavailable";
        setPageStatus(unavailable ? state.message : EXPIRY_MESSAGE, unavailable);
        await options.refreshAccount().catch(() => {});
      }
    } catch (error) {
      if (error instanceof DashboardApiError && (error.status === 401 || error.status === 403)) {
        pollingBlocked = true;
        stopPolling();
        const message = "Dashboard authorization expired. Reload this local dashboard to continue.";
        if (proposal) {
          dialogError.textContent = message;
          dialogError.hidden = false;
        } else {
          setPageStatus(message, true);
        }
      }
      // Other failures reconnect on the next interval without changing server state.
    } finally {
      pollInFlight = false;
    }
  };

  const updateCountdown = () => {
    if (!active) return;
    const remainingSeconds = Math.max(0, Math.ceil((Date.parse(active.expiresAt) - now()) / 1_000));
    countdown.textContent = countdownText(active.expiresAt, now());
    if (remainingSeconds === 0) {
      thresholdStatus.textContent = "Confirmation expired.";
    } else if (lastRemainingSeconds !== null) {
      const crossed = [10, 30, 60].find(
        (threshold) => lastRemainingSeconds! > threshold && remainingSeconds <= threshold,
      );
      if (crossed !== undefined) thresholdStatus.textContent = `${crossed} seconds remaining.`;
    }
    lastRemainingSeconds = remainingSeconds;
    if (remainingSeconds === 0) void poll();
  };

  const showProposal = (proposal: CodexRedemptionProposalView) => {
    active = proposal;
    pollingBlocked = false;
    try {
      sessionStorage.setItem(SESSION_PROPOSAL_KEY, JSON.stringify({ proposalId: proposal.proposalId }));
    } catch {
      // Reconnect persistence is best effort and never changes server state.
    }
    lastRemainingSeconds = null;
    description.replaceChildren();
    for (const text of [
      `${proposal.account.email} · ${proposal.account.plan} plan · ${proposal.availableCount} reset${proposal.availableCount === 1 ? "" : "s"} available.`,
      usageText(proposal),
      confirmationText(proposal),
    ]) {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      description.append(paragraph);
    }
    dialogError.hidden = true;
    dialogError.textContent = "";
    thresholdStatus.textContent = "";
    cancelButton.disabled = false;
    cancelButton.textContent = "Cancel";
    confirmButton.disabled = false;
    stopTimers();
    updateCountdown();
    options.dialog.showModal();
    cancelButton.focus();
    countdownTimer = window.setInterval(updateCountdown, 250);
    pollTimer = window.setInterval(() => void poll(), 1_000);
  };

  const closePostDispatch = (message: string) => {
    stopCountdown();
    if (options.dialog.open) options.dialog.close();
    cancelButton.disabled = false;
    cancelButton.textContent = "Close";
    confirmButton.disabled = true;
    setPageStatus(message, true);
    options.focusFallback.focus();
  };

  const consumeActive = async () => {
    if (!active || consuming || finishing) return;
    const proposal = active;
    consuming = true;
    postDispatch = true;
    cancelButton.disabled = true;
    confirmButton.disabled = true;
    options.dialog.setAttribute("aria-busy", "true");
    setPageStatus("Sending reset redemption…");
    thresholdStatus.textContent = "Sending reset redemption. Please wait.";
    const request = api.consume(proposal.proposalId);
    let deadlineReached = false;
    consumeDeadlineTimer = window.setTimeout(() => {
      deadlineReached = true;
      consuming = false;
      cancelButton.disabled = false;
      cancelButton.textContent = "Close";
      setPageStatus("Redemption is still processing. You may close this dialog; polling continues.");
      thresholdStatus.textContent = "Still processing. Close is available; polling continues.";
    }, 20_000);
    try {
      const result = await request;
      if (consumeDeadlineTimer !== null) window.clearTimeout(consumeDeadlineTimer);
      consumeDeadlineTimer = null;
      options.dialog.removeAttribute("aria-busy");
      if (active !== proposal) return;
      if (result.status === "terminal") {
        if (result.accountUsage) {
          options.applyAccountUsage?.(result.accountUsage);
          await finish(result.message, false);
        } else if (result.reconciliation === "unreconciled" || result.reconciliation === "availability-changed-unreconciled") {
          options.markAccountUsageStale?.(result.message);
          await finish(result.message, false);
        } else {
          await finish(result.message, true);
        }
      } else if (result.status === "ambiguous") {
        consuming = false;
        closePostDispatch("Couldn’t confirm whether redemption completed. Retry uses the same attempt and cannot repeat a completed redemption.");
      } else if (result.status === "recovery-required" || result.status === "unavailable") {
        await finish(result.message, true);
      } else {
        consuming = false;
        closePostDispatch("Redemption state changed. Review current recovery state before continuing.");
      }
    } catch (error) {
      if (consumeDeadlineTimer !== null) window.clearTimeout(consumeDeadlineTimer);
      consumeDeadlineTimer = null;
      options.dialog.removeAttribute("aria-busy");
      if (error instanceof DashboardApiError && error.status === 409 && (
        error.code === "codex_account_changed" ||
        error.code === "codex_reset_availability_changed" ||
        error.code === "codex_session_changed" ||
        error.code === "codex_proposal_expired"
      )) {
        await finish(error.message, true);
        return;
      }
      if (deadlineReached) {
        setPageStatus("Redemption outcome is not confirmed. Keep this dashboard open to continue polling.", true);
      } else {
        consuming = false;
        cancelButton.disabled = false;
        cancelButton.textContent = "Close";
        dialogError.textContent = error instanceof DashboardApiError && (error.status === 401 || error.status === 403)
          ? "Dashboard authorization expired after redemption started. Reload this local dashboard to continue recovery."
          : "Redemption outcome is not confirmed. Close is available; polling continues.";
        dialogError.hidden = false;
        setPageStatus("Redemption outcome is not confirmed. Keep this dashboard open to continue polling.", true);
      }
    }
  };

  const cancelActive = async () => {
    if (postDispatch) {
      if (!consuming) closePostDispatch("Redemption continues in the background. Keep this dashboard open to continue polling.");
      return;
    }
    if (!active || finishing) return;
    const proposal = active;
    finishing = true;
    cancelButton.disabled = true;
    try {
      await api.cancel(proposal.proposalId);
      finishing = false;
      await finish("Confirmation cancelled.", false);
    } catch {
      finishing = false;
      dialogError.textContent = "Couldn’t cancel confirmation. Try again.";
      dialogError.hidden = false;
      cancelButton.disabled = false;
      cancelButton.focus();
    }
  };

  options.panel.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const form = event.target.closest<HTMLElement>("[data-codex-redemption-form]");
    if (!form) return;
    const attested = form.querySelector<HTMLInputElement>("[data-codex-workspace-attestation]")?.checked === true;
    const selected = Boolean(form.querySelector<HTMLInputElement>('input[name="codex-reset-selection"]:checked:not(:disabled)'));
    const button = form.querySelector<HTMLButtonElement>("[data-codex-redemption-prepare]");
    if (button) {
      button.disabled = !(attested && selected);
      button.removeAttribute("aria-disabled");
    }
  });

  options.panel.addEventListener("submit", (event) => {
    const form = event.target instanceof HTMLFormElement && event.target.matches("[data-codex-redemption-form]")
      ? event.target
      : null;
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector<HTMLButtonElement>("[data-codex-redemption-prepare]");
    const attestation = form.querySelector<HTMLInputElement>("[data-codex-workspace-attestation]");
    const selected = form.querySelector<HTMLInputElement>('input[name="codex-reset-selection"]:checked:not(:disabled)');
    if (!button || !attestation?.checked || !selected || active) {
      if (button?.getAttribute("aria-disabled") === "true") {
        setPageStatus("Confirm the single-workspace boundary before continuing.", true);
      }
      return;
    }
    opener = button;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    setPageStatus("");
    const input = selected.hasAttribute("data-codex-reset-generic")
      ? { singleWorkspaceAttested: true as const }
      : { creditId: selected.value, singleWorkspaceAttested: true as const };
    void api.prepare(input).then(
      showProposal,
      () => {
        button.removeAttribute("aria-busy");
        button.disabled = !(attestation.checked && Boolean(selected));
        setPageStatus("Couldn’t prepare reset confirmation. Review account details and try again.", true);
      },
    );
  });

  cancelButton.addEventListener("click", () => void cancelActive());
  confirmButton.addEventListener("click", () => void consumeActive());
  options.dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    void cancelActive();
  });

  if (pendingProposalId) {
    pollTimer = window.setInterval(() => void poll(), 1_000);
    void poll();
  }

  return {
    close: stopTimers,
    resume(state) {
      if (!state || active) return;
      if (state.status === "recovery-required" || state.status === "unavailable") {
        pendingProposalId = null;
        stopTimers();
        try {
          sessionStorage.removeItem(SESSION_PROPOSAL_KEY);
        } catch {
          // Session storage is optional; server state remains authoritative.
        }
        setPageStatus(state.message, true);
        return;
      }
      if (state.status === "ambiguous" || state.status === "terminal") {
        pendingProposalId = null;
        stopTimers();
        try {
          sessionStorage.removeItem(SESSION_PROPOSAL_KEY);
        } catch {
          // Session storage is optional; server state remains authoritative.
        }
        setPageStatus(state.status === "terminal" ? state.message : "Couldn’t confirm whether redemption completed. Retry uses the same attempt and cannot repeat a completed redemption.", state.status === "ambiguous");
        return;
      }
      if (state.status === "processing") {
        pendingProposalId = state.proposalId;
        if (!pollingBlocked && pollTimer === null) pollTimer = window.setInterval(() => void poll(), 1_000);
        setPageStatus("Redemption is processing. Polling continues.");
        return;
      }
      if (state.status !== "prepared") return;
      if ("account" in state) {
        if (pendingProposalId && pendingProposalId !== state.proposalId) {
          pendingProposalId = null;
          stopTimers();
          try {
            sessionStorage.removeItem(SESSION_PROPOSAL_KEY);
          } catch {
            // Session storage is optional; server state remains authoritative.
          }
          setPageStatus("Another reset confirmation is active. Return to its original dashboard tab or wait for expiry.");
          return;
        }
        pendingProposalId = null;
        opener = options.focusFallback;
        showProposal(state);
      } else {
        pendingProposalId = state.proposalId;
        if (!pollingBlocked && pollTimer === null) pollTimer = window.setInterval(() => void poll(), 1_000);
        setPageStatus("Another reset confirmation is active. Return to its original dashboard tab or wait for expiry.");
      }
    },
  };
}
