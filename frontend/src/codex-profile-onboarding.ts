import type {
  CodexProfileCandidateView,
  CodexProfileConfirmedView,
} from "../../shared/codex-profile-onboarding-types";
import {
  DashboardApiError,
  cancelCodexLoginProfile,
  confirmCodexLoginProfile,
  createCodexLoginProfile,
  observeCodexLoginProfile,
  retryCodexLoginProfile,
} from "./api";

type OnboardingMode = "idle" | "login" | "candidate" | "candidate-error" | "confirmed";
type OnboardingAction = "add" | "check" | "retry" | "confirm" | "cancel";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Codex profile onboarding element: ${id}`);
  return element as T;
}

function planLabel(plan: string): string {
  return plan
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function usageLabel(window: CodexProfileCandidateView["usage"]["primary"]): string {
  if (!window) return "Not reported";
  const percent = window.usedPercent === null ? "Usage unavailable" : `${window.usedPercent}% used`;
  const duration = window.durationMinutes === null ? "window duration unavailable" : `${window.durationMinutes} minute window`;
  const reset = window.resetsAt ? `resets ${new Date(window.resetsAt).toLocaleString()}` : "reset time unavailable";
  return `${percent} · ${duration} · ${reset}`;
}

export function setupCodexProfileOnboarding(onProfileChanged: () => void | Promise<void> = () => {}) {
  const addButton = byId<HTMLButtonElement>("add-codex-login-profile");
  const status = byId("codex-profile-onboarding-status");
  const error = byId("codex-profile-onboarding-error");
  const workspace = byId("codex-profile-onboarding-workspace");
  const instructions = byId("codex-profile-onboarding-instructions");
  const candidateDetails = byId("codex-profile-candidate-details");
  const email = byId("codex-profile-candidate-email");
  const plan = byId("codex-profile-candidate-plan");
  const primaryUsage = byId("codex-profile-candidate-primary-usage");
  const resetCredits = byId("codex-profile-candidate-reset-credits");
  const observedAt = byId("codex-profile-candidate-observed-at");
  const confirmationLabel = byId("codex-profile-confirmation-label");
  const confirmation = byId<HTMLInputElement>("codex-profile-confirmation");
  const checkButton = byId<HTMLButtonElement>("check-codex-login-profile");
  const retryButton = byId<HTMLButtonElement>("retry-codex-login-profile");
  const confirmButton = byId<HTMLButtonElement>("confirm-codex-login-profile");
  const cancelButton = byId<HTMLButtonElement>("cancel-codex-login-profile");

  let activeProfileId: string | null = null;
  let candidate: CodexProfileCandidateView | null = null;
  let mode: OnboardingMode = "idle";
  let busyAction: OnboardingAction | null = null;
  let operationGeneration = 0;

  const fixedError = (caught: unknown): string =>
    caught instanceof DashboardApiError ? caught.message : "Codex Login Profile onboarding failed.";

  const clearError = () => {
    error.textContent = "";
    error.hidden = true;
  };

  const showError = (caught: unknown) => {
    if (activeProfileId && mode === "login") mode = "candidate-error";
    error.textContent = fixedError(caught);
    error.hidden = false;
    updateControls();
  };

  const updateControls = () => {
    const busy = busyAction !== null;
    addButton.disabled = busy || activeProfileId !== null;
    addButton.setAttribute("aria-busy", String(busyAction === "add"));
    checkButton.hidden = mode !== "login";
    retryButton.hidden = mode !== "candidate" && mode !== "candidate-error";
    confirmButton.hidden = mode !== "candidate";
    cancelButton.hidden = mode === "idle" || mode === "confirmed";
    confirmationLabel.hidden = mode !== "candidate";
    checkButton.disabled = busy;
    retryButton.disabled = busy;
    cancelButton.disabled = busy && busyAction !== "check";
    confirmButton.disabled = busy || !confirmation.checked;
    workspace.setAttribute("aria-busy", String(busy));
  };

  const showLogin = (message: string) => {
    mode = "login";
    candidate = null;
    confirmation.checked = false;
    workspace.hidden = false;
    candidateDetails.hidden = true;
    instructions.textContent = "Finish the official browser login for this private profile, then check the logged-in account.";
    status.textContent = message;
    clearError();
    updateControls();
  };

  const showCandidate = (value: CodexProfileCandidateView | CodexProfileConfirmedView) => {
    candidate = value.status === "awaiting-confirmation" ? value : null;
    mode = value.status === "confirmed" ? "confirmed" : "candidate";
    workspace.hidden = false;
    candidateDetails.hidden = false;
    email.textContent = value.account.email;
    plan.textContent = planLabel(value.account.plan);
    primaryUsage.textContent = usageLabel(value.usage.primary);
    resetCredits.textContent = value.resetCredits.availableCount === null
      ? "Unavailable"
      : `${value.resetCredits.availableCount} available`;
    observedAt.textContent = new Date(value.observedAt).toLocaleString();
    confirmation.checked = false;
    instructions.textContent = value.status === "confirmed"
      ? "Confirmed read-only account and rate-limit result."
      : "Check the account below. Retry browser login if the browser used the wrong account.";
    clearError();
    updateControls();
  };

  const run = async (
    action: OnboardingAction,
    operation: (isCurrent: () => boolean) => Promise<HTMLElement | null>,
  ) => {
    if (busyAction && !(action === "cancel" && busyAction === "check")) return;
    const generation = action === "cancel" ? ++operationGeneration : operationGeneration;
    busyAction = action;
    clearError();
    updateControls();
    let focusTarget: HTMLElement | null = null;
    try {
      focusTarget = await operation(() => generation === operationGeneration);
    } catch (caught) {
      if (generation === operationGeneration) {
        showError(caught);
        focusTarget = activeProfileId ? retryButton : addButton;
      }
    } finally {
      if (generation === operationGeneration) {
        busyAction = null;
        updateControls();
        focusTarget?.focus();
      }
    }
  };

  addButton.addEventListener("click", () => void run("add", async (isCurrent) => {
    const created = await createCodexLoginProfile();
    if (!isCurrent()) return null;
    activeProfileId = created.profileId;
    void onProfileChanged();
    showLogin("Finish the official browser login, then check the logged-in Codex app account.");
    return checkButton;
  }));

  checkButton.addEventListener("click", () => void run("check", async (isCurrent) => {
    if (!activeProfileId) return null;
    const observed = await observeCodexLoginProfile(activeProfileId);
    if (!isCurrent()) return null;
    showCandidate(observed);
    status.textContent = "Read-only account check complete. Confirm this account or retry browser login.";
    return confirmation;
  }));

  retryButton.addEventListener("click", () => void run("retry", async (isCurrent) => {
    if (!activeProfileId) return null;
    await retryCodexLoginProfile(activeProfileId);
    if (!isCurrent()) return null;
    showLogin("Browser login restarted. Finish the official browser login, then check the account again.");
    return checkButton;
  }));

  confirmation.addEventListener("change", updateControls);

  confirmButton.addEventListener("click", () => void run("confirm", async (isCurrent) => {
    if (!activeProfileId || !candidate || !confirmation.checked) return null;
    const confirmed = await confirmCodexLoginProfile(activeProfileId, {
      confirmed: true,
      email: candidate.account.email,
      plan: candidate.account.plan,
    });
    if (!isCurrent()) return null;
    activeProfileId = null;
    void onProfileChanged();
    showCandidate(confirmed);
    status.textContent = `Codex Login Profile confirmed for ${confirmed.account.email}.`;
    return addButton;
  }));

  cancelButton.addEventListener("click", () => void run("cancel", async (isCurrent) => {
    const profileId = activeProfileId;
    if (!profileId) return null;
    await cancelCodexLoginProfile(profileId);
    if (!isCurrent()) return null;
    activeProfileId = null;
    candidate = null;
    mode = "idle";
    void onProfileChanged();
    workspace.hidden = true;
    status.textContent = "Onboarding cancelled. Pending Codex Login Profile data was cleaned up.";
    clearError();
    return addButton;
  }));

  return { updateControls };
}
