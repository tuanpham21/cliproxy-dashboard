import type { DashboardState, PublicAccountView, PublicRotationState } from "../../shared/types";
import { escapeHtml, formatToGmt7, formatValue } from "./format";

export type RotationPanelData = Pick<DashboardState, "accounts" | "rotation">;

function lifecycleBadge(lifecycle: PublicRotationState["lifecycle"]): string {
  if (lifecycle === "active" || lifecycle === "shadow") return "good";
  if (lifecycle === "paused" || lifecycle === "recovery-required") return "bad";
  if (lifecycle === "pending" || lifecycle === "awaiting-confirmation" || lifecycle === "recovering" || lifecycle === "manual-hold") return "warn";
  return "neutral";
}

function accountLabel(accounts: PublicAccountView[], proxyAccountKey: string | undefined): string {
  if (!proxyAccountKey) return "none";
  const account = accounts.find((candidate) => candidate.proxyAccountKey === proxyAccountKey);
  return account ? `${account.email} · ${account.fileName}` : proxyAccountKey;
}

function metric(label: string, value: unknown, detail = ""): string {
  return `
    <div class="rotation-metric">
      <div class="label">${escapeHtml(label)}</div>
      <div class="value mono">${escapeHtml(formatValue(value))}</div>
      ${detail ? `<div class="muted small">${escapeHtml(detail)}</div>` : ""}
    </div>
  `;
}

function poolModeLabel(_poolMode: PublicRotationState["poolMode"]): string {
  return "manual";
}

function renderPoolAccount(account: PublicAccountView, rotation: PublicRotationState): string {
  const proxyAccountKey = account.proxyAccountKey;
  const member = proxyAccountKey
    ? rotation.pool.find((candidate) => candidate.proxyAccountKey === proxyAccountKey)
    : undefined;
  const escapedFileName = escapeHtml(account.fileName);
  const escapedKey = escapeHtml(proxyAccountKey ?? "");
  return `
    <div class="rotation-pool-row" data-rotation-pool-row>
      <div>
        <strong>${escapeHtml(account.email)}</strong>
        <div class="muted small mono">${escapedFileName}</div>
        <div class="muted small mono">${proxyAccountKey ? escapedKey : "Proxy Account Key unavailable"}</div>
      </div>
      <div class="rotation-pool-intent">
        ${member
          ? '<span class="badge good">exclusive intent recorded</span>'
          : `<label class="small checkbox-inline"><input type="checkbox" data-rotation-exclusivity /> Proxy-exclusive usage attested</label>`}
      </div>
      <button
        type="button"
        data-rotation-pool-action="${member ? "remove" : "add"}"
        data-proxy-account-key="${escapedKey}"
        data-file-name="${escapedFileName}"
        ${proxyAccountKey ? "" : "disabled"}
      >${member ? "Remove" : "Add to pool"}</button>
    </div>
  `;
}

export function renderRotationPanel(data: RotationPanelData): string {
  const rotation = data.rotation;
  if (!rotation) {
    return '<div class="rotation-empty muted">Rotation coordinator unavailable. Automatic rotation remains off.</div>';
  }
  const intended = accountLabel(data.accounts, rotation.routingTargetKey);
  const observed = accountLabel(data.accounts, rotation.observedRoutedAccountKey);
  const journalTarget = accountLabel(data.accounts, rotation.journal.routingTargetKey);
  const pauseDetail = [rotation.pauseReason, rotation.pauseMessage].filter(Boolean).join(" · ");
  const audit = [...rotation.audit].reverse().slice(0, 20);
  const activeDisabled = rotation.canActivate ? "" : "disabled";

  return `
    <div class="rotation-controls" aria-label="Quota-Balanced Rotation controls">
      <div class="rotation-mode-controls">
        ${(["off", "shadow", "active"] as const).map((mode) => `
          <button
            type="button"
            data-rotation-mode="${mode}"
            class="${rotation.mode === mode ? "primary" : ""}"
            aria-pressed="${rotation.mode === mode}"
            ${mode === "active" ? activeDisabled : ""}
            title="${mode === "active" && !rotation.canActivate ? "CLIProxy management key required" : `Set ${mode} mode`}"
          >${mode}</button>
        `).join("")}
      </div>
      <div class="rotation-action-controls">
        <button type="button" data-rotation-action="pause">Pause</button>
        <button type="button" data-rotation-action="manual-hold">Manual Hold</button>
        <button type="button" data-rotation-action="resume" class="primary">Resume</button>
        <button type="button" data-rotation-action="recover">Recover to Off</button>
      </div>
      <div class="rotation-pool-mode-controls">
        <button
          type="button"
          data-rotation-pool-mode="manual"
          class="primary"
          aria-pressed="true"
        >manual pool</button>
      </div>
    </div>

    <div class="rotation-statusline">
      <span class="badge ${lifecycleBadge(rotation.lifecycle)}">${escapeHtml(rotation.lifecycle)}</span>
      <span class="muted small">Mode ${escapeHtml(rotation.mode)} · pool ${escapeHtml(poolModeLabel(rotation.poolMode))} · active writes ${rotation.canActivate ? "available" : "blocked"}</span>
    </div>
    ${pauseDetail ? `<div class="rotation-alert"><strong>Pause / recovery reason</strong><span>${escapeHtml(pauseDetail)}</span></div>` : ""}

    <div class="rotation-metrics">
      ${metric("Intended Routing Target", intended)}
      ${metric("Observed Routed Account", observed)}
      ${metric("Rotation-Eligible", rotation.eligibleCount)}
      ${metric("Provisional Reset", rotation.provisionalCount)}
      ${metric("Pool Mode", poolModeLabel(rotation.poolMode))}
      ${metric("Quota Spread", rotation.quotaSpread === undefined ? "unknown" : `${rotation.quotaSpread} pp`)}
      ${metric("Journal", rotation.journal.phase, rotation.journal.intendedPriority === undefined ? journalTarget : `${journalTarget} · priority ${rotation.journal.intendedPriority}`)}
      ${metric("Restoration", rotation.restorationVerified ? "verified" : "not verified")}
      ${metric("Routing compatibility", rotation.routingCompatible ? "compatible" : "blocked", rotation.routingCompatibilityMessage)}
      ${metric("Evidence watermark", rotation.evidenceWatermark ? formatToGmt7(rotation.evidenceWatermark) : "none")}
    </div>

    <div class="rotation-decision">
      <div class="label">Latest decision</div>
      <div><span class="badge ${rotation.lastDecision?.kind === "pause" ? "bad" : "neutral"}">${escapeHtml(rotation.lastDecision?.kind ?? "none")}</span></div>
      <div>${escapeHtml(rotation.lastDecision?.reason ?? "No decision recorded")}</div>
    </div>

    <div class="rotation-columns">
      <div class="rotation-subpanel">
        <div class="rotation-subtitle">
          <h3>Rotation Pool</h3>
          <span class="badge neutral">${rotation.pool.length} members</span>
        </div>
        <div class="rotation-pool-list">
          ${data.accounts.length
            ? data.accounts.map((account) => renderPoolAccount(account, rotation)).join("")
            : '<div class="muted small">No Proxy Accounts available.</div>'}
        </div>
      </div>

      <div class="rotation-subpanel">
        <div class="rotation-subtitle">
          <h3>Audit history</h3>
          <span class="badge neutral">latest ${audit.length}</span>
        </div>
        <div class="rotation-audit-list">
          ${audit.length
            ? audit.map((event) => `
                <div class="rotation-audit-row">
                  <div class="rotation-audit-meta"><span class="badge neutral">${escapeHtml(event.kind)}</span><span class="mono">${escapeHtml(formatToGmt7(event.at))}</span></div>
                  <div>${escapeHtml(event.message)}</div>
                  ${event.pauseReason ? `<div class="muted small">${escapeHtml(event.pauseReason)}</div>` : ""}
                </div>
              `).join("")
            : '<div class="muted small">No rotation audit events recorded.</div>'}
        </div>
      </div>
    </div>
  `;
}
