import { deleteJson, postJson, putJson, readCodexAccountUsage, readDashboardState } from "./api";
import { codexLoadingView } from "./codex-app-account";
import { setupCodexRedemption } from "./codex-redemption";
import { inferPlan } from "./format";
import {
  type AppState,
  type DashboardElements,
  render,
  renderCodexAccountPanel,
  renderModels,
  setTestStatus,
} from "./render";
import "./theme.css";
import "./account.css";
import "./rotation.css";
import "./codex-account.css";
import "./styles.css";

const state: AppState = {
  data: null,
  codexAccount: codexLoadingView(),
  busy: false,
  refreshTimer: null,
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing dashboard element: ${id}`);
  }
  return element as T;
}

const els: DashboardElements = {
  refreshMeta: byId("refresh-meta"),
  summary: byId("summary"),
  configPath: byId("config-path"),
  routingStrategy: byId("routing-strategy"),
  sessionAffinity: byId("session-affinity"),
  saveRouting: byId("save-routing"),
  accounts: byId("accounts"),
  accountCount: byId("account-count"),
  selectedAccount: byId("selected-account"),
  selectorLog: byId("selector-log"),
  requestLog: byId("request-log"),
  errors: byId("errors"),
  testPrompt: byId("test-prompt"),
  testModel: byId("test-model"),
  testTokens: byId("test-tokens"),
  modelCount: byId("model-count"),
  modelList: byId("model-list"),
  sendTest: byId("send-test"),
  testStatus: byId("test-status"),
  testMessage: byId("test-message"),
  testOutput: byId("test-output"),
  pasteJsonArea: byId("paste-json-area"),
  importJsonBtn: byId("import-json-btn"),
  triggerOauthBtn: byId("trigger-oauth-btn"),
  verifyAllBtn: byId("verify-all-btn"),
  rotation: byId("rotation"),
  codexAccount: byId("codex-app-account-content"),
};

let codexRefreshPromise: Promise<void> | null = null;
let codexRedemptionController: ReturnType<typeof setupCodexRedemption> | null = null;

function activeElementBlocksRefresh(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) {
    return false;
  }
  const isEditable = active.tagName === "INPUT" || active.tagName === "SELECT" || active.tagName === "TEXTAREA";
  if (!isEditable) {
    return false;
  }
  return (
    els.accounts.contains(active) ||
    els.rotation.contains(active) ||
    els.codexAccount.contains(active) ||
    active.id === "routing-strategy" ||
    active.id === "session-affinity"
  );
}

async function refresh(): Promise<void> {
  if (state.busy || activeElementBlocksRefresh()) {
    return;
  }
  state.busy = true;
  try {
    const [dashboardResult] = await Promise.allSettled([readDashboardState(), refreshCodexAccount(false)]);
    if (dashboardResult.status === "fulfilled") {
      state.data = dashboardResult.value;
    } else {
      render(state, els, { codexAccount: false });
      throw dashboardResult.reason;
    }
    render(state, els, { codexAccount: false });
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  } finally {
    state.busy = false;
  }
}

function refreshCodexAccount(showLoading = true): Promise<void> {
  if (codexRefreshPromise) return codexRefreshPromise;
  if (showLoading) {
    state.codexAccount = codexLoadingView();
    renderCodexAccountPanel(state, els);
  }
  codexRefreshPromise = readCodexAccountUsage()
      .then((result) => {
        state.codexAccount = result;
        renderCodexAccountPanel(state, els);
        codexRedemptionController?.resume(result.activeRedemption);
    })
    .finally(() => {
      codexRefreshPromise = null;
    });
  return codexRefreshPromise;
}

function accountPayload(row: HTMLTableRowElement): { priority?: number | null; note?: string | null; disabled?: boolean | null } {
  const priorityField = row.querySelector<HTMLInputElement>('[data-field="priority"]');
  const noteField = row.querySelector<HTMLInputElement>('[data-field="note"]');
  const disabledField = row.querySelector<HTMLInputElement>('[data-field="disabled"]');
  return {
    priority: priorityField && priorityField.value.trim() !== "" ? Number(priorityField.value) : null,
    note: noteField ? noteField.value : null,
    disabled: disabledField ? Boolean(disabledField.checked) : null,
  };
}

els.accounts.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest<HTMLButtonElement>("button[data-action]");
  const row = button?.closest<HTMLTableRowElement>("tr[data-file]");
  if (!button || !row) {
    return;
  }
  const fileName = row.getAttribute("data-file");
  const action = button.getAttribute("data-action");
  if (!fileName || !action) {
    return;
  }

  try {
    setTestStatus(els, "neutral", `updating ${fileName}...`);
    if (action === "reauth") {
      const email = row.querySelector("strong")?.textContent || "";
      const result = await postJson<{ url?: string }>("/api/accounts/login-oauth", { email });
      if (result.url) {
        window.open(result.url, "_blank");
      }
      setTestStatus(els, "good", `Reauthentication triggered for ${email}`);
    } else if (action === "verify") {
      const result = await postJson<{ valid?: boolean; refreshed?: boolean; error?: string }>(
        `/api/accounts/${encodeURIComponent(fileName)}/verify`,
        {},
      );
      if (result.valid) {
        setTestStatus(els, "good", `${fileName} is valid${result.refreshed ? " (refreshed)" : ""}`);
      } else {
        setTestStatus(els, "warn", `${fileName} is invalid: ${result.error || "unknown error"}`);
      }
    } else if (action === "save") {
      await postJson(`/api/accounts/${encodeURIComponent(fileName)}`, accountPayload(row));
    } else if (action === "primary") {
      await postJson(`/api/accounts/${encodeURIComponent(fileName)}/primary`, {});
    } else if (action === "backup") {
      await postJson(`/api/accounts/${encodeURIComponent(fileName)}/backup`, {});
    } else if (action === "clear") {
      await postJson(`/api/accounts/${encodeURIComponent(fileName)}/clear-priority`, {});
    } else if (action === "toggle") {
      const disabledField = row.querySelector<HTMLInputElement>('[data-field="disabled"]');
      await postJson(`/api/accounts/${encodeURIComponent(fileName)}`, {
        disabled: !(disabledField && disabledField.checked),
      });
    } else if (action === "delete") {
      const email = row.querySelector("strong")?.textContent || fileName;
      if (!window.confirm(`Delete "${email}"?\\n\\nThe file will be backed up before removal.`)) {
        return;
      }
      await deleteJson(`/api/accounts/${encodeURIComponent(fileName)}`);
      setTestStatus(els, "good", `${email} deleted successfully`);
      await refresh();
      return;
    }

    await refresh();
    if (action !== "verify" && action !== "reauth") {
      setTestStatus(els, "good", `${fileName} updated`);
    }
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  }
});

els.verifyAllBtn.addEventListener("click", async () => {
  const accounts = state.data?.accounts || [];
  if (!accounts.length) {
    return;
  }
  els.verifyAllBtn.disabled = true;
  const originalText = els.verifyAllBtn.textContent ?? "Verify All";
  try {
    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index];
      els.verifyAllBtn.textContent = `Verifying ${index + 1}/${accounts.length}...`;
      setTestStatus(els, "neutral", `Verifying ${account.email}...`);
      await postJson(`/api/accounts/${encodeURIComponent(account.fileName)}/verify`, {});
    }
    setTestStatus(els, "good", "All accounts verified successfully");
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  } finally {
    els.verifyAllBtn.disabled = false;
    els.verifyAllBtn.textContent = originalText;
    await refresh();
  }
});

els.modelList.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest<HTMLButtonElement>("button[data-model-id]");
  const modelId = button?.getAttribute("data-model-id");
  if (!modelId) {
    return;
  }
  els.testModel.value = modelId;
  renderModels(state, els);
});

els.testModel.addEventListener("input", () => renderModels(state, els));

els.saveRouting.addEventListener("click", async () => {
  try {
    setTestStatus(els, "neutral", "saving routing...");
    await postJson("/api/routing", {
      strategy: els.routingStrategy.value,
      sessionAffinity: els.sessionAffinity.checked,
    });
    await refresh();
    setTestStatus(els, "good", "routing saved");
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  }
});

els.rotation.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest<HTMLButtonElement>("button");
  if (!button) return;
  const mode = button.getAttribute("data-rotation-mode");
  const action = button.getAttribute("data-rotation-action");
  const poolAction = button.getAttribute("data-rotation-pool-action");
  if (!mode && !action && !poolAction) return;

  button.disabled = true;
  try {
    setTestStatus(els, "neutral", "updating Quota-Balanced Rotation...");
    if (mode) {
      await postJson("/api/rotation/mode", { mode });
    } else if (action === "pause") {
      await postJson("/api/rotation/pause", { message: "Operator paused Quota-Balanced Rotation" });
    } else if (action === "manual-hold") {
      await postJson("/api/rotation/manual-hold", { message: "Operator entered Manual Hold from dashboard" });
    } else if (action === "resume") {
      await postJson("/api/rotation/resume", {});
    } else if (action === "recover") {
      await postJson("/api/rotation/recover", {});
    } else if (poolAction) {
      const proxyAccountKey = button.getAttribute("data-proxy-account-key") ?? "";
      const fileName = button.getAttribute("data-file-name") ?? "";
      if (!proxyAccountKey || !fileName) throw new Error("Proxy Account Key and file name are required");
      if (poolAction === "add") {
        const row = button.closest<HTMLElement>("[data-rotation-pool-row]");
        const exclusivity = row?.querySelector<HTMLInputElement>("[data-rotation-exclusivity]");
        if (!exclusivity?.checked) throw new Error("Proxy-exclusive usage attestation is required");
        await putJson(`/api/rotation/pool/${encodeURIComponent(proxyAccountKey)}`, { fileName, exclusivityAttested: true });
      } else if (poolAction === "remove") {
        await deleteJson(`/api/rotation/pool/${encodeURIComponent(proxyAccountKey)}`);
      }
    }
    await refresh();
    setTestStatus(els, "good", "Quota-Balanced Rotation updated");
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
  }
});

els.sendTest.addEventListener("click", async () => {
  try {
    setTestStatus(els, "neutral", "sending test request...");
    els.testOutput.textContent = "";
    const result = await postJson<{
      requestId: string;
      ok: boolean;
      status: number;
      responseText: string;
      latestCodexSelection?: { auth: string } | null;
    }>("/api/test-request", {
      prompt: els.testPrompt.value,
      model: els.testModel.value,
      maxOutputTokens: Number(els.testTokens.value),
    });
    setTestStatus(els, result.ok ? "good" : "warn", `request ${result.requestId} -> ${result.status}`);
    els.testOutput.textContent = [
      `requestId: ${result.requestId}`,
      `status: ${result.status}`,
      "",
      result.responseText || "",
      "",
      result.latestCodexSelection ? `latest codex auth: ${result.latestCodexSelection.auth}` : "latest codex auth: none",
    ].join("\\n");
    await refresh();
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  }
});

els.importJsonBtn.addEventListener("click", async () => {
  try {
    const text = els.pasteJsonArea.value.trim();
    if (!text) {
      throw new Error("JSON area is empty");
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("Invalid JSON: must be an object");
    }
    if (typeof parsed.email !== "string" || !parsed.email.trim()) {
      throw new Error("Pasted JSON must contain an email field");
    }
    const plan =
      typeof parsed.plan === "string"
        ? parsed.plan
        : typeof parsed.fileName === "string"
          ? inferPlan(parsed.fileName)
          : typeof parsed.plan_type === "string"
            ? parsed.plan_type
            : "free";

    setTestStatus(els, "neutral", "importing Codex account...");
    const result = await postJson<{ account: { email: string } }>("/api/accounts", {
      email: parsed.email.trim(),
      plan: plan.trim(),
      priority: typeof parsed.priority === "number" ? parsed.priority : 100,
      note: typeof parsed.note === "string" ? parsed.note.trim() : "",
      account_id: typeof parsed.account_id === "string" ? parsed.account_id.trim() : "",
      access_token: typeof parsed.access_token === "string" ? parsed.access_token.trim() : "",
      id_token: typeof parsed.id_token === "string" ? parsed.id_token.trim() : "",
      refresh_token: typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim() : "",
      disabled: typeof parsed.disabled === "boolean" ? parsed.disabled : false,
      expired: typeof parsed.expired === "string" ? parsed.expired.trim() : "",
      last_refresh: typeof parsed.last_refresh === "string" ? parsed.last_refresh.trim() : "",
    });
    setTestStatus(els, "good", `Account ${result.account.email} imported successfully`);
    els.pasteJsonArea.value = "";
    await refresh();
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  }
});

els.triggerOauthBtn.addEventListener("click", async () => {
  try {
    setTestStatus(els, "neutral", "Triggering browser OAuth login...");
    const result = await postJson<{ url?: string }>("/api/accounts/login-oauth", {});
    if (result.url) {
      window.open(result.url, "_blank");
    }
    setTestStatus(els, "good", "OAuth login triggered in a new browser tab.");
  } catch (error) {
    setTestStatus(els, "bad", error instanceof Error ? error.message : String(error));
  }
});

const refreshCodexAccountButton = byId<HTMLButtonElement>("refresh-codex-account-btn");
  refreshCodexAccountButton.addEventListener("click", async () => {
  refreshCodexAccountButton.disabled = true;
  refreshCodexAccountButton.setAttribute("aria-busy", "true");
  try {
    await refreshCodexAccount();
  } finally {
    refreshCodexAccountButton.disabled = false;
    refreshCodexAccountButton.removeAttribute("aria-busy");
    }
  });
  codexRedemptionController = setupCodexRedemption({
    panel: els.codexAccount,
    dialog: byId<HTMLDialogElement>("codex-redemption-dialog"),
    pageStatus: byId("codex-redemption-page-status"),
    focusFallback: refreshCodexAccountButton,
    refreshAccount: async () => await refreshCodexAccount(false),
  });

  const themeToggle = byId<HTMLButtonElement>("theme-toggle");

function getTheme(): "dark" | "light" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function updateThemeIcon(theme: "dark" | "light"): void {
  if (theme === "dark") {
    themeToggle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
  } else {
    themeToggle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;
  }
}

function setTheme(theme: "dark" | "light"): void {
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);
  updateThemeIcon(theme);
}

  const savedTheme = localStorage.getItem("theme") === "light" ? "light" : "dark";
  setTheme(savedTheme);
  themeToggle.addEventListener("click", () => setTheme(getTheme() === "dark" ? "light" : "dark"));

  renderCodexAccountPanel(state, els);
  void refresh();
state.refreshTimer = window.setInterval(refresh, 60000);
