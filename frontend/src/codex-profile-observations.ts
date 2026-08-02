import type {
  CodexProfileObservationListView,
  CodexProfileObservationRowView,
} from "../../shared/codex-profile-observation-types";
import { summarizeCodexProfileObservations } from "../../shared/codex-profile-observation-types";
import type { CodexProfileRefreshRunView } from "../../shared/codex-profile-refresh-types";
import {
  cancelCodexLoginProfileRefreshAll,
  deleteCodexLoginProfile,
  DashboardApiError,
  readCodexLoginProfiles,
  readCodexLoginProfileRefreshAll,
  refreshCodexLoginProfile,
  reorderCodexLoginProfiles,
  startCodexLoginProfileRefreshAll,
  updateCodexLoginProfile,
} from "./api";

type RowAction = "refresh" | "toggle" | "save" | "up" | "down" | "relogin" | "delete" | "continue";

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing Codex Profile Observation element: ${id}`);
  return element as T;
}
function statusLabel(status: CodexProfileObservationRowView["status"]): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function planLabel(plan: string): string {
  return plan.split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function windowLabel(window: NonNullable<CodexProfileObservationRowView["observation"]>["usage"]["primary"]): string {
  if (!window) return "Not reported";
  const used = window.usedPercent === null ? "Usage unavailable" : `${window.usedPercent}% used`;
  const duration = window.durationMinutes === null ? "Window unknown" : `${window.durationMinutes.toLocaleString()} min`;
  const reset = window.resetsAt === null
    ? "Reset time unavailable"
    : `Resets ${new Date(window.resetsAt).toLocaleString()}`;
  return `${used} · ${duration} · ${reset}`;
}

function evidenceTrack(label: string, window: NonNullable<CodexProfileObservationRowView["observation"]>["usage"]["primary"]) {
  const wrapper = document.createElement("div");
  wrapper.className = "codex-profile-evidence-track";
  const heading = document.createElement("span");
  heading.className = "codex-profile-evidence-label";
  heading.textContent = label;
  const text = document.createElement("span");
  text.textContent = windowLabel(window);
  const bar = document.createElement("span");
  bar.className = "codex-profile-evidence-bar";
  const fill = document.createElement("span");
  fill.style.width = `${window?.usedPercent ?? 0}%`;
  bar.append(fill);
  wrapper.append(heading, text, bar);
  return wrapper;
}

function rowElement(profile: CodexProfileObservationRowView, count: number): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.dataset.profileId = profile.profileId;
  const profileCell = document.createElement("td");
  profileCell.dataset.label = "Profile";
  const label = document.createElement("input");
  label.value = profile.label;
  label.maxLength = 80;
  label.dataset.field = "label";
  label.setAttribute("aria-label", `Label for ${profile.label}`);
  profileCell.append(label);

  const accountCell = document.createElement("td");
  accountCell.dataset.label = "Account";
  accountCell.textContent = profile.observation
    ? `${profile.observation.account.email} · ${planLabel(profile.observation.account.plan)}`
    : profile.status === "pending"
      ? "Browser login pending — finish setup"
      : "Not observed";

  const evidenceCell = document.createElement("td");
  evidenceCell.dataset.label = "Evidence rail";
  evidenceCell.className = "codex-profile-evidence-rail";
  if (profile.observation) {
    evidenceCell.append(
      evidenceTrack("Primary", profile.observation.usage.primary),
      evidenceTrack("Secondary", profile.observation.usage.secondary),
    );
    const observed = document.createElement("small");
    observed.textContent = `${statusLabel(profile.observation.freshness)} · ${new Date(profile.observation.observedAt).toLocaleString()} · ${profile.observation.runtimeVersion}`;
    evidenceCell.append(observed);
  } else {
    evidenceCell.textContent = "No retained observation";
  }

  const resetsCell = document.createElement("td");
  resetsCell.dataset.label = "Resets";
  const resetCount = profile.observation?.resetCredits.availableCount;
  resetsCell.textContent = resetCount === null || resetCount === undefined ? "Unavailable" : `${resetCount} available`;

  const statusCell = document.createElement("td");
  statusCell.dataset.label = "Status";
  const badge = document.createElement("span");
  badge.className = `codex-profile-status codex-profile-status-${profile.status}`;
  badge.textContent = statusLabel(profile.status);
  statusCell.append(badge);

  if (profile.status === "pending") {
    const help = document.createElement("span");
    help.className = "codex-profile-row-help";
    help.textContent = "Setup incomplete — click “Continue setup”";
    statusCell.append(help);
  } else if (!profile.enabled) {
    const help = document.createElement("span");
    help.className = "codex-profile-row-help";
    help.textContent = "Profile disabled — click “Enable” to refresh";
    statusCell.append(help);
  } else if (profile.status === "re-login-required" || profile.status === "identity-changed") {
    const help = document.createElement("span");
    help.className = "codex-profile-row-help danger";
    help.textContent = "Auth required — click “Log in again”";
    statusCell.append(help);
  }

  const actionsCell = document.createElement("td");
  actionsCell.dataset.label = "Actions";
  actionsCell.className = "codex-profile-observation-actions";
  const redemptionStatus = profile.activeRedemption?.status;
  const redemptionAllowsPrepare = !redemptionStatus || redemptionStatus === "not-found" || redemptionStatus === "terminal";
  const actions: Array<[RowAction, string, boolean]> = profile.status === "cleanup-required"
    ? [["delete", `Retry cleanup for ${profile.label}`, false]]
    : [
      ["save", `Save label for ${profile.label}`, false],
      ...(profile.status === "pending"
        ? [["continue", `Continue setup for ${profile.label}`, false] as [RowAction, string, boolean]]
        : []),
      ["refresh", `Refresh ${profile.label}`, profile.status === "pending" || !profile.enabled || !redemptionAllowsPrepare],
      ...(profile.status === "identity-changed" || profile.status === "re-login-required"
        ? [["relogin", `Log in again for ${profile.label}`, false] as [RowAction, string, boolean]] : []),
      ["toggle", `${profile.enabled ? "Disable" : "Enable"} ${profile.label}`, profile.status === "pending" ||
        profile.status === "identity-changed" || profile.status === "re-login-required"],
      ["up", `Move ${profile.label} up`, profile.order === 0],
      ["down", `Move ${profile.label} down`, profile.order === count - 1],
      ["delete", `Delete ${profile.label}`, false],
    ];
  for (const [action, accessibleName, disabled] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.disabled = disabled;
    button.setAttribute("aria-label", accessibleName);
    if (disabled) {
      if (profile.status === "pending") {
        button.title = "Setup incomplete: click 'Continue setup' to finish onboarding";
      } else if (!profile.enabled) {
        button.title = "Profile disabled: click 'Enable' to refresh";
      }
    }
    button.textContent = action === "toggle" ? (profile.enabled ? "Disable" : "Enable")
      : action === "save" ? "Save label"
        : action === "continue" ? "Continue setup"
          : action === "refresh" ? "Refresh"
            : action === "up" ? "↑"
              : action === "down" ? "↓"
                : action === "relogin" ? "Log in again"
                  : "Delete";
    actionsCell.append(button);
  }

  if (redemptionStatus && redemptionStatus !== "not-found" && redemptionStatus !== "terminal") {
    const recovery = document.createElement("small");
    recovery.className = "codex-profile-redemption-state";
    recovery.textContent = `Reset redemption: ${redemptionStatus}.`;
    actionsCell.prepend(recovery);
  }
  row.append(profileCell, accountCell, evidenceCell, resetsCell, statusCell, actionsCell);
  return row;
}

export function setupCodexProfileObservations(options: {
    onContinueSetup?: (profileId: string, label?: string) => void | Promise<void>;
    onReLogin?: (profileId: string) => void | Promise<void>;
    onRedemptionState?: (state: NonNullable<CodexProfileObservationRowView["activeRedemption"]>) => void;
  } = {}) {
  const summary = byId("codex-profile-observation-summary");
  const status = byId("codex-profile-observation-status");
  const error = byId("codex-profile-observation-error");
  const rows = byId<HTMLTableSectionElement>("codex-profile-observation-rows");
  const refreshAllButton = byId<HTMLButtonElement>("refresh-all-codex-login-profiles");
  const cancelRefreshAllButton = byId<HTMLButtonElement>("cancel-refresh-all-codex-login-profiles");
  const redemptionPanel = document.getElementById("codex-profile-redemption-panel");
  let current: CodexProfileObservationListView = { profiles: [], summary: summarizeCodexProfileObservations([]) };
  let busy = false;

  const renderRedemptionPanel = () => {
    if (!redemptionPanel) return;
    redemptionPanel.replaceChildren();
    let hasPanel = false;
    for (const profile of current.profiles) {
      const redemptionStatus = profile.activeRedemption?.status;
      const redemptionAllowsPrepare = !redemptionStatus || redemptionStatus === "not-found" || redemptionStatus === "terminal";
      const availableResets = profile.observation?.resetCredits.availableCount ?? 0;
      const canPrepareReset = profile.enabled && availableResets > 0 && redemptionAllowsPrepare && [
        "fresh",
        "latest-known",
        "refresh-needed",
        "stale",
      ].includes(profile.status);

      if (canPrepareReset) {
        hasPanel = true;
        const card = document.createElement("div");
        card.className = "codex-profile-redemption-card";

        const title = document.createElement("h3");
        title.className = "codex-profile-redemption-title";
        title.textContent = `⚡ Redeem Usage Limit Reset Credit — ${profile.label}`;

        const warning = document.createElement("p");
        warning.className = "codex-profile-redemption-warning-copy";
        warning.textContent = `Warning: Redeeming a reset credit permanently consumes an OpenAI entitlement. Availability checks above are safe and read-only. (${availableResets} available for ${profile.observation?.account.email ?? profile.label})`;

        const form = document.createElement("form");
        form.className = "codex-profile-redemption-form";
        form.dataset.codexRedemptionForm = "";
        form.dataset.profileId = profile.profileId;

        const attestation = document.createElement("label");
        attestation.className = "codex-profile-redemption-attestation";

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.codexWorkspaceAttestation = "";

        const copy = document.createElement("span");
        copy.textContent = `${profile.label} uses one ChatGPT workspace for Codex, and this is the workspace whose earned reset I intend to use.`;

        attestation.append(checkbox, copy);

        const review = document.createElement("button");
        review.type = "submit";
        review.className = "primary danger-btn";
        review.dataset.codexRedemptionPrepare = "";
        review.disabled = true;
        review.setAttribute("aria-label", `Review reset for ${profile.label}`);
        review.textContent = "Review reset";

        form.append(attestation, review);
        card.append(title, warning, form);
        redemptionPanel.append(card);
      }
    }
    redemptionPanel.hidden = !hasPanel;
  };

  const render = () => {
    const value = current.summary;
    summary.textContent = `${value.total} profiles · ${value.profilesWithResets} with resets · ${value.fresh} fresh · ${value.refreshNeeded} refresh-needed · ${value.stale} stale · ${value.latestKnown} latest-known · ${value.pending} pending · ${value.reLoginRequired} re-login-required · ${value.identityChanged} identity-changed · ${value.cleanupRequired} cleanup-required · ${value.disabled} disabled · ${value.neverObserved} never-observed`;
    rows.replaceChildren(...current.profiles.map((profile) => rowElement(profile, current.profiles.length)));
    if (current.profiles.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "codex-profile-observation-empty";
      cell.textContent = "No Reset Checker Profiles yet. Add one to retain read-only usage evidence.";
      row.append(cell);
      rows.append(row);
    }
    renderRedemptionPanel();
  };

  const showError = (caught: unknown) => {
    error.textContent = caught instanceof DashboardApiError ? caught.message : "Couldn’t load Reset Checker Profiles.";
    error.hidden = false;
  };

  const renderRefreshAll = (run: CodexProfileRefreshRunView) => {
    const currentProfile = run.profiles.find((profile) => profile.profileId === run.currentProfileId);
    const failed = run.profiles.filter((profile) => profile.status === "failed").length;
    refreshAllButton.disabled = run.outcome === "running";
    cancelRefreshAllButton.disabled = run.outcome !== "running";
    if (run.outcome === "idle") return;
    if (run.outcome === "running") {
      status.textContent = `Refreshing ${run.completed} of ${run.total}${currentProfile ? ` · ${currentProfile.label}` : ""}`;
      return;
    }
    if (run.outcome === "completed") {
      status.textContent = `Refresh all completed · ${run.completed} of ${run.total}`;
      return;
    }
    if (run.outcome === "partial") {
      status.textContent = `Refresh all partially completed · ${run.completed} of ${run.total} · ${failed} failed`;
      return;
    }
    status.textContent = `Refresh all cancelled · ${run.completed} of ${run.total}`;
  };

    const loadProfiles = async () => {
      current = await readCodexLoginProfiles();
      render();
      const active = current.profiles.find((profile) => profile.activeRedemption && profile.activeRedemption.status !== "not-found")?.activeRedemption;
      if (active) options.onRedemptionState?.(active);
    };

  const monitorRefreshAll = async (initial: CodexProfileRefreshRunView) => {
    let run = initial;
    busy = run.outcome === "running";
    rows.setAttribute("aria-busy", String(busy));
    renderRefreshAll(run);
    while (run.outcome === "running") {
      await new Promise((resolve) => setTimeout(resolve, 250));
      run = await readCodexLoginProfileRefreshAll();
      renderRefreshAll(run);
    }
    busy = false;
    rows.setAttribute("aria-busy", "false");
    await loadProfiles();
  };

  const refresh = async () => {
    try {
      const [profiles, refreshAll] = await Promise.all([
        readCodexLoginProfiles(),
        readCodexLoginProfileRefreshAll(),
      ]);
        current = profiles;
        error.hidden = true;
        render();
        const active = profiles.profiles.find((profile) => profile.activeRedemption && profile.activeRedemption.status !== "not-found")?.activeRedemption;
        if (active) options.onRedemptionState?.(active);
        renderRefreshAll(refreshAll);
      if (refreshAll.outcome === "running") void monitorRefreshAll(refreshAll).catch(showError);
    } catch (caught) {
      showError(caught);
    }
  };

  refreshAllButton.addEventListener("click", () => {
    if (busy) return;
    void (async () => {
      error.hidden = true;
      try {
        await monitorRefreshAll(await startCodexLoginProfileRefreshAll());
      } catch (caught) {
        busy = false;
        rows.setAttribute("aria-busy", "false");
        showError(caught);
      }
    })();
  });

  cancelRefreshAllButton.addEventListener("click", () => {
    if (!busy) return;
    cancelRefreshAllButton.disabled = true;
    void cancelCodexLoginProfileRefreshAll()
      .then(renderRefreshAll)
      .catch(showError);
  });

  const replaceRow = (updated: CodexProfileObservationRowView) => {
    current.profiles = current.profiles.map((profile) => profile.profileId === updated.profileId ? updated : profile);
    current.summary = summarizeCodexProfileObservations(current.profiles);
    render();
  };

  rows.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
    const row = button?.closest<HTMLTableRowElement>("tr[data-profile-id]");
    if (!button || !row || busy) return;
    const profileId = row.dataset.profileId!;
    const profile = current.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) return;
    const action = button.dataset.action as RowAction;
    void (async () => {
      busy = true;
      error.hidden = true;
      rows.setAttribute("aria-busy", "true");
      try {
        if (action === "continue") {
          await options.onContinueSetup?.(profileId, profile.label);
          status.textContent = `Setup resumed for ${profile.label}.`;
        } else if (action === "refresh") {
          status.textContent = `Refreshing ${profile.label}…`;
          replaceRow(await refreshCodexLoginProfile(profileId));
          status.textContent = `${profile.label} refreshed.`;
        } else if (action === "save") {
          const input = row.querySelector<HTMLInputElement>('[data-field="label"]');
          replaceRow(await updateCodexLoginProfile(profileId, { label: input?.value ?? profile.label }));
          status.textContent = "Profile label saved.";
          } else if (action === "toggle") {
            replaceRow(await updateCodexLoginProfile(profileId, { enabled: !profile.enabled }));
            status.textContent = `${profile.label} ${profile.enabled ? "disabled" : "enabled"}.`;
          } else if (action === "relogin") {
            await options.onReLogin?.(profileId);
            status.textContent = `Log in again started for ${profile.label}.`;
          } else if (action === "delete") {
            if (!window.confirm(`Delete Codex Login Profile "${profile.label}"?\n\nThis removes its local metadata, latest observation, and managed login root.`)) {
              return;
            }
            await deleteCodexLoginProfile(profileId);
            current = await readCodexLoginProfiles();
            render();
            status.textContent = `${profile.label} deleted.`;
          } else {
          const ids = current.profiles.map((candidate) => candidate.profileId);
          const from = ids.indexOf(profileId);
          const to = action === "up" ? from - 1 : from + 1;
          [ids[from], ids[to]] = [ids[to]!, ids[from]!];
          current = await reorderCodexLoginProfiles({ profileIds: ids });
          render();
          status.textContent = `${profile.label} moved.`;
        }
      } catch (caught) {
          if (action === "refresh" || action === "delete") {
          try {
            current = await readCodexLoginProfiles();
            render();
          } catch {}
        }
        status.textContent = `${profile.label} action failed.`;
        showError(caught);
      } finally {
        busy = false;
        rows.setAttribute("aria-busy", "false");
      }
    })();
  });

  render();
  void refresh();
    return { refresh };
}
