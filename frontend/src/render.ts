import {
  badgeClass,
  escapeHtml,
  formatDateGmt7,
  formatToGmt7,
  formatValue,
  quotaStatusClass,
  quotaUsageClass,
  relativeAge,
  resetLabel,
} from "./format";
import type { DashboardState, PublicAccountView, PublicQuotaWindow, RateLimitState } from "../../shared/types";
import { renderRotationPanel } from "./rotation";

export type DashboardElements = {
  refreshMeta: HTMLElement;
  summary: HTMLElement;
  configPath: HTMLElement;
  routingStrategy: HTMLSelectElement;
  sessionAffinity: HTMLInputElement;
  saveRouting: HTMLButtonElement;
  accounts: HTMLTableSectionElement;
  accountCount: HTMLElement;
  selectedAccount: HTMLElement;
  selectorLog: HTMLElement;
  requestLog: HTMLElement;
  errors: HTMLElement;
  testPrompt: HTMLInputElement;
  testModel: HTMLInputElement;
  testTokens: HTMLInputElement;
  modelCount: HTMLElement;
  modelList: HTMLElement;
  sendTest: HTMLButtonElement;
  testStatus: HTMLElement;
  testMessage: HTMLElement;
  testOutput: HTMLElement;
  pasteJsonArea: HTMLTextAreaElement;
  importJsonBtn: HTMLButtonElement;
  triggerOauthBtn: HTMLButtonElement;
  verifyAllBtn: HTMLButtonElement;
  rotation: HTMLElement;
};

export type AppState = {
  data: DashboardState | null;
  rateLimits: RateLimitState | null;
  busy: boolean;
  refreshTimer: number | null;
};

function selectedAuthName(data: DashboardState): string {
  return data.selectedAccount?.email ?? data.logSummary.latestCodexSelection?.auth ?? "none";
}

export function renderModels(state: AppState, els: DashboardElements): void {
  const data = state.data;
  if (!data) {
    return;
  }
  const currentModel = els.testModel.value.trim();
  els.modelCount.textContent = `${data.models.length} model${data.models.length === 1 ? "" : "s"}`;
  els.modelList.innerHTML = data.models.length
    ? data.models
        .map((model) => {
          const active = model.id === currentModel;
          return [
            `<button type="button" class="model-chip ${active ? "active" : ""}"`,
            ` data-model-id="${escapeHtml(model.id)}"`,
            ` title="${escapeHtml(model.ownedBy || "unknown")}">`,
            `<span class="mono">${escapeHtml(model.id)}</span>`,
            `<span class="muted meta">${escapeHtml(model.ownedBy || "unknown")}</span>`,
            "</button>",
          ].join("");
        })
        .join("")
    : '<div class="muted small">No models were returned by /v1/models.</div>';
}

function renderSummary(state: AppState, els: DashboardElements): void {
  const data = state.data;
  if (!data) {
    return;
  }
  const config = data.config;
  const selection = data.logSummary.latestCodexSelection;
  const latestRequest = data.logSummary.latestRequest;
  els.summary.innerHTML = [
    {
      label: "Proxy config",
      value: config ? config.path : data.paths.configPath,
      badge: config ? "good" : "warn",
    },
    {
      label: "Routing",
      value: config
        ? `${config.routingStrategy} / session-affinity ${config.sessionAffinity ? "on" : "off"}`
        : "unknown",
      badge: config ? "good" : "warn",
    },
    {
      label: "Auth dir",
      value: data.paths.authDir,
      badge: "neutral",
    },
    {
      label: "Proxy URL",
      value: data.paths.proxyUrl,
      badge: "neutral",
    },
    {
      label: "Latest Codex auth",
      value: selection ? selection.auth : "none",
      badge: selection ? "good" : "warn",
    },
    {
      label: "Latest request",
      value: latestRequest ? `${latestRequest.status} ${latestRequest.method} ${latestRequest.path}` : "none",
      badge: latestRequest ? "good" : "warn",
    },
  ]
    .map(
      (item) => `
        <div class="stat">
          <div class="label">${escapeHtml(item.label)} <span class="badge ${badgeClass(item.badge)}">${escapeHtml(item.badge)}</span></div>
          <div class="value mono">${escapeHtml(formatValue(item.value))}</div>
        </div>
      `,
    )
    .join("");
  els.refreshMeta.textContent = "last refresh " + formatToGmt7(data.lastRefreshedAt);
  els.configPath.textContent = data.paths.configPath;
  if (config) {
    els.routingStrategy.value = config.routingStrategy;
    els.sessionAffinity.checked = Boolean(config.sessionAffinity);
  }
  els.accountCount.textContent = `${data.accounts.length} accounts`;
  els.selectedAccount.textContent = `selected ${selectedAuthName(data)}`;
  els.errors.innerHTML = data.errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("");
}

function renderQuotaWindow(label: string, windowQuota: PublicQuotaWindow | undefined): string {
  const quota = windowQuota ?? { status: "unknown" };
  const usageClass = quotaUsageClass(quota.usedPercent);
  const statusClass = quotaStatusClass(quota.status);
  if (typeof quota.usedPercent !== "number") {
    return `
      <div class="quota-window">
        <div class="quota-label">${escapeHtml(label)}</div>
        <div class="quota-unknown">Unknown</div>
        <div class="quota-status ${statusClass}">${escapeHtml(quota.status)}</div>
      </div>
    `;
  }
  const remaining = Math.max(0, 100 - quota.usedPercent);
  const fillPct = Math.max(0, 100 - quota.usedPercent);
  const reset = resetLabel(quota.resetAt);
  const observed = relativeAge(quota.observedAt);
  const availabilityLabel = quota.status === "current" ? "remaining" : "latest known";
  return `
    <div class="quota-window">
      <div class="quota-label">${escapeHtml(label)}</div>
      <div class="quota-value ${usageClass}">${escapeHtml(`${remaining}% ${availabilityLabel}`)}</div>
      <div class="quota-bar-container">
        <div class="quota-bar-fill ${usageClass}" data-width="${fillPct}"></div>
      </div>
      <div class="quota-status ${statusClass}">${escapeHtml(quota.status)}</div>
      ${reset ? `<div class="quota-note">${escapeHtml(reset)}</div>` : ""}
      ${observed ? `<div class="quota-note">${escapeHtml(observed)}</div>` : ""}
    </div>
  `;
}

function statusBadge(account: PublicAccountView): string {
  if (account.validityStatus === "valid") {
    return '<div class="status-pulse-container"><span class="status-pulse good"></span><div class="badge good">Valid</div></div>';
  }
  if (account.validityStatus === "invalid") {
    const tooltip = escapeHtml(account.validationError || "Session has ended");
    return `<div class="status-pulse-container"><span class="status-pulse bad"></span><div class="badge bad" title="${tooltip}">Session ended</div></div>`;
  }
  return '<div class="status-pulse-container"><span class="status-pulse neutral"></span><div class="badge neutral">Unverified</div></div>';
}

function planBadge(account: PublicAccountView): string {
  const planDisplay = account.subscriptionPlan || account.plan || "free";
  const isPlus = planDisplay.toLowerCase() === "plus";
  const labelText = isPlus ? "Plus" : "Free";
  return `<span class="badge ${isPlus ? "warn plan-plus" : "neutral"} plan-badge">${escapeHtml(labelText)}</span>`;
}

function renderAccounts(state: AppState, els: DashboardElements): void {
  const data = state.data;
  if (!data) {
    return;
  }
  const selectedFile = data.logSummary.latestCodexSelection?.auth ?? "";
  els.accounts.innerHTML = data.accounts
    .map((account, index) => {
      const selected = selectedFile === account.fileName;
      const priorityValue = account.explicitPriority ? String(account.priority) : "";
      const quotaCell = [
        renderQuotaWindow("5 hour usage limit", account.quota?.primary5h),
        renderQuotaWindow("Weekly usage limit", account.quota?.weekly),
      ].join("");
      const showReauth = account.validityStatus === "invalid";
      const isExpired = account.expired ? new Date(account.expired) < new Date() : false;
      const expiryText = isExpired
        ? `${formatToGmt7(account.expired)} (Expired)`
        : account.expired
          ? formatToGmt7(account.expired)
          : "-";
      const isSubExpired = account.subscriptionActiveUntil
        ? new Date(account.subscriptionActiveUntil) < new Date()
        : false;
      const subExpiryText = isSubExpired
        ? `${formatDateGmt7(account.subscriptionActiveUntil)} (Expired)`
        : account.subscriptionActiveUntil
          ? formatDateGmt7(account.subscriptionActiveUntil)
          : "-";

      return `
        <tr class="${selected ? "row-active" : ""}" data-file="${escapeHtml(account.fileName)}">
          <td class="mono tabular-nums">${index + 1}</td>
          <td>
            <div class="account-name"><strong>${escapeHtml(account.email)}</strong>${planBadge(account)}</div>
            <div class="muted mono">${escapeHtml(account.fileName)}</div>
            <div class="muted small mono">${escapeHtml(account.accountIdShort || "-")} ${escapeHtml(account.type || "")}</div>
          </td>
          <td class="priority-cell">
            <input class="field inline mono tabular-nums" data-field="priority" value="${escapeHtml(priorityValue)}" placeholder="${account.priority}" />
            <div class="muted small">${account.explicitPriority ? "explicit" : "default"} ${account.disabled ? "disabled" : "enabled"}</div>
          </td>
          <td class="note-cell">
            <input class="field inline" data-field="note" value="${escapeHtml(account.note)}" placeholder="note" />
          </td>
          <td>
            <label class="small checkbox-inline"><input type="checkbox" data-field="disabled" ${account.disabled ? "checked" : ""} /> disabled</label>
            ${statusBadge(account)}
          </td>
          <td class="quota-cell">${quotaCell}</td>
          <td class="mono small tabular-nums timing-cell">
            <div title="Last refresh"><span class="muted">Ref:</span> ${escapeHtml(account.lastRefresh ? formatToGmt7(account.lastRefresh) : "-")}</div>
            <div title="OAuth session expires at" class="${isExpired ? "expired" : ""}"><span class="muted">Exp:</span> ${escapeHtml(expiryText)}</div>
            <div title="ChatGPT subscription active until" class="${isSubExpired ? "expired" : ""}"><span class="muted">Sub:</span> ${escapeHtml(subExpiryText)}</div>
          </td>
          <td>
            <div class="account-actions">
              <div class="action-row">
                <button type="button" data-action="verify" class="action-verify" title="Verify token">✓ Verify</button>
                <button type="button" data-action="primary" class="action-primary" title="Set as primary">★ Primary</button>
              </div>
              <div class="action-row">
                <button type="button" data-action="save" title="Save priority/note changes">Save</button>
                <button type="button" data-action="toggle" title="${account.disabled ? "Enable this account" : "Disable this account"}" class="${account.disabled ? "action-enable" : ""}">${account.disabled ? "Enable" : "Disable"}</button>
              </div>
              <div class="action-row">
                ${showReauth ? '<button type="button" data-action="reauth" class="action-reauth" title="Reauthenticate">⟳ Reauth</button>' : ""}
                <button type="button" data-action="backup" title="Set as low-priority backup">Backup</button>
                <button type="button" data-action="clear" title="Remove explicit priority">Clear ★</button>
              </div>
              <div class="action-row danger-row">
                <button type="button" data-action="delete" class="action-delete" title="Permanently delete this profile">🗑 Delete</button>
              </div>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  const fills = els.accounts.querySelectorAll<HTMLElement>(".quota-bar-fill");
  fills.forEach((fill) => {
    const widthVal = fill.getAttribute("data-width");
    if (widthVal) {
      fill.style.width = `${widthVal}%`;
    }
  });
}

function renderLogs(state: AppState, els: DashboardElements): void {
  const data = state.data;
  if (!data) {
    return;
  }
  const selections = data.logSummary.recentSelections;
  const requests = data.logSummary.recentRequests;
  const selectedFile = data.logSummary.latestCodexSelection?.auth ?? "";
  els.selectorLog.innerHTML = selections.length
    ? selections
        .map(
          (item) =>
            `<pre class="log ${item.auth === selectedFile ? "row-highlight" : ""}">${escapeHtml(item.raw)}</pre>`,
        )
        .join("")
    : '<div class="muted">No selector lines found in the tail of main.log.</div>';
  els.requestLog.innerHTML = requests.length
    ? requests.map((item) => `<pre class="log">${escapeHtml(item.raw)}</pre>`).join("")
    : '<div class="muted">No request lines found in the tail of main.log.</div>';
}

function renderRateLimits(state: AppState): void {
  const section = document.getElementById("rate-limits-section");
  const count = document.getElementById("reset-credits-count");
  if (!section || !count) {
    return;
  }
  const rateLimits = state.rateLimits;
  if (!rateLimits?.ok || rateLimits.availableCount <= 0) {
    section.classList.add("is-hidden");
    return;
  }
  section.classList.remove("is-hidden");
  count.textContent = String(rateLimits.availableCount);
}

function renderRotation(state: AppState, els: DashboardElements): void {
  if (!state.data) return;
  els.rotation.innerHTML = renderRotationPanel(state.data);
}

export function render(state: AppState, els: DashboardElements): void {
  renderSummary(state, els);
  renderAccounts(state, els);
  renderModels(state, els);
  renderLogs(state, els);
  renderRateLimits(state);
  renderRotation(state, els);
}

export function setTestStatus(els: DashboardElements, kind: string, message: string): void {
  els.testStatus.className = `badge ${badgeClass(kind)}`;
  els.testStatus.textContent = kind;
  els.testMessage.textContent = message;
}
