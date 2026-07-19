import type {
  CodexProfileObservationListView,
  CodexProfileObservationRowView,
} from "../../shared/codex-profile-observation-types";
import { summarizeCodexProfileObservations } from "../../shared/codex-profile-observation-types";
import type { CodexProfileRefreshRunView } from "../../shared/codex-profile-refresh-types";
import {
  cancelCodexLoginProfileRefreshAll,
  DashboardApiError,
  readCodexLoginProfiles,
  readCodexLoginProfileRefreshAll,
  refreshCodexLoginProfile,
  reorderCodexLoginProfiles,
  startCodexLoginProfileRefreshAll,
  updateCodexLoginProfile,
} from "./api";

type RowAction = "refresh" | "toggle" | "save" | "up" | "down";

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

  const actionsCell = document.createElement("td");
  actionsCell.dataset.label = "Actions";
  actionsCell.className = "codex-profile-observation-actions";
  const actions: Array<[RowAction, string, boolean]> = [
    ["save", `Save label for ${profile.label}`, false],
    ["refresh", `Refresh ${profile.label}`, profile.status === "pending" || !profile.enabled],
      ["toggle", `${profile.enabled ? "Disable" : "Enable"} ${profile.label}`, profile.status === "pending" ||
        profile.status === "identity-changed" || profile.status === "re-login-required"],
    ["up", `Move ${profile.label} up`, profile.order === 0],
    ["down", `Move ${profile.label} down`, profile.order === count - 1],
  ];
  for (const [action, accessibleName, disabled] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    button.disabled = disabled;
    button.setAttribute("aria-label", accessibleName);
    button.textContent = action === "toggle" ? (profile.enabled ? "Disable" : "Enable")
      : action === "save" ? "Save label"
        : action === "refresh" ? "Refresh"
          : action === "up" ? "↑"
            : "↓";
    actionsCell.append(button);
  }
  row.append(profileCell, accountCell, evidenceCell, resetsCell, statusCell, actionsCell);
  return row;
}

export function setupCodexProfileObservations() {
  const summary = byId("codex-profile-observation-summary");
  const status = byId("codex-profile-observation-status");
  const error = byId("codex-profile-observation-error");
  const rows = byId<HTMLTableSectionElement>("codex-profile-observation-rows");
  const refreshAllButton = byId<HTMLButtonElement>("refresh-all-codex-login-profiles");
  const cancelRefreshAllButton = byId<HTMLButtonElement>("cancel-refresh-all-codex-login-profiles");
  let current: CodexProfileObservationListView = { profiles: [], summary: summarizeCodexProfileObservations([]) };
  let busy = false;

  const render = () => {
    const value = current.summary;
    summary.textContent = `${value.total} profiles · ${value.profilesWithResets} with resets · ${value.fresh} fresh · ${value.refreshNeeded} refresh-needed · ${value.stale} stale · ${value.latestKnown} latest-known · ${value.pending} pending · ${value.reLoginRequired} re-login-required · ${value.identityChanged} identity-changed · ${value.disabled} disabled · ${value.neverObserved} never-observed`;
    rows.replaceChildren(...current.profiles.map((profile) => rowElement(profile, current.profiles.length)));
    if (current.profiles.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 6;
      cell.className = "codex-profile-observation-empty";
      cell.textContent = "No Codex Login Profiles yet. Add one to retain read-only usage evidence.";
      row.append(cell);
      rows.append(row);
    }
  };

  const showError = (caught: unknown) => {
    error.textContent = caught instanceof DashboardApiError ? caught.message : "Couldn’t load Codex Login Profiles.";
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
        if (action === "refresh") {
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
        if (action === "refresh") {
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
