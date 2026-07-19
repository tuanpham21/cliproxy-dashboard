import type { CodexAccountUsageView, DashboardState, RateLimitState } from "../../shared/types";
import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
  CodexRedemptionStateView,
  LegacyPrepareCodexRedemptionInput,
} from "../../shared/codex-account-types";
import type {
  CodexProfileCandidateView,
  CodexProfileCancelledView,
  CodexProfileConfirmedView,
  CodexProfileLoginStartedView,
  ConfirmCodexProfileInput,
} from "../../shared/codex-profile-onboarding-types";
import type {
  CodexProfileObservationListView,
  CodexProfileObservationRowView,
  ReorderCodexProfilesInput,
  UpdateCodexProfileMetadataInput,
} from "../../shared/codex-profile-observation-types";
import type { CodexProfileRefreshRunView } from "../../shared/codex-profile-refresh-types";

const TOKEN_PLACEHOLDER = "__CLIPROXY_OPERATOR_TOKEN__";
const OPERATOR_TOKEN_HEADER = "x-cliproxy-dashboard-token";

let operatorTokenPromise: Promise<string> | null = null;

export class DashboardApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.name = "DashboardApiError";
    this.status = status;
    this.code = code;
  }
}

function operatorTokenFromMeta(): string {
  if (typeof document === "undefined") {
    return "";
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[name="cliproxy-dashboard-token"]');
  const value = meta?.content.trim() ?? "";
  return value && value !== TOKEN_PLACEHOLDER ? value : "";
}

export async function getOperatorToken(): Promise<string> {
  const metaToken = operatorTokenFromMeta();
  if (metaToken) {
    return metaToken;
  }
  operatorTokenPromise ??= fetch("/api/bootstrap", { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`bootstrap request failed: ${response.status}`);
      }
      const parsed = (await response.json()) as { operatorToken?: unknown };
      return typeof parsed.operatorToken === "string" ? parsed.operatorToken : "";
    })
    .catch((error) => {
      operatorTokenPromise = null;
      throw error;
    });
  return operatorTokenPromise;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  requiresOperatorToken = false,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (requiresOperatorToken) {
    const operatorToken = await getOperatorToken();
    if (!operatorToken) {
      throw new Error("dashboard operator token is unavailable");
    }
    headers.set(OPERATOR_TOKEN_HEADER, operatorToken);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    cache: init.cache ?? "no-store",
  });
  const parsed = await parseResponse(response);
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error?: unknown }).error)
          : `request failed: ${response.status}`;
    const code = parsed && typeof parsed === "object" && "code" in parsed
      ? String((parsed as { code?: unknown }).code)
      : null;
    throw new DashboardApiError(response.status, detail, code);
  }
  return parsed as T;
}

export async function readDashboardState(): Promise<DashboardState> {
  return await requestJson<DashboardState>("/api/state");
}

export async function readRateLimits(): Promise<RateLimitState | null> {
  try {
    return await requestJson<RateLimitState>("/api/codex/rate-limits", {}, true);
  } catch {
    return null;
  }
}

export async function postJson<T>(url: string, payload: unknown): Promise<T> {
  return await requestJson<T>(
    url,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    true,
  );
}

export async function readCodexAccountUsage(): Promise<CodexAccountUsageView> {
  try {
    return await requestJson<CodexAccountUsageView>("/api/codex/account-usage", {}, true);
  } catch {
    return {
      state: "read-failed",
      errorCode: "codex_read_failed",
      message: "Couldn’t load Codex app usage.",
      runtime: { status: "unknown", version: null },
      account: null,
      observedAt: null,
      usage: null,
      resetCredits: null,
    };
  }
}

export async function createCodexLoginProfile(): Promise<CodexProfileLoginStartedView> {
  return await postJson<CodexProfileLoginStartedView>("/api/codex/login-profiles", {});
}

export async function observeCodexLoginProfile(profileId: string): Promise<CodexProfileCandidateView> {
  return await requestJson<CodexProfileCandidateView>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}/onboarding`,
    {},
    true,
  );
}

export async function retryCodexLoginProfile(profileId: string): Promise<CodexProfileLoginStartedView> {
  return await postJson<CodexProfileLoginStartedView>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}/retry`,
    {},
  );
}

export async function confirmCodexLoginProfile(
  profileId: string,
  input: ConfirmCodexProfileInput,
): Promise<CodexProfileConfirmedView> {
  return await postJson<CodexProfileConfirmedView>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}/confirm`,
    input,
  );
}

export async function cancelCodexLoginProfile(profileId: string): Promise<CodexProfileCancelledView> {
  return await deleteJson<CodexProfileCancelledView>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}`,
  );
}

export async function readCodexLoginProfiles(): Promise<CodexProfileObservationListView> {
  return await requestJson<CodexProfileObservationListView>("/api/codex/login-profiles", {}, true);
}

export async function refreshCodexLoginProfile(profileId: string): Promise<CodexProfileObservationRowView> {
  return await postJson<CodexProfileObservationRowView>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}/refresh`,
    {},
  );
}

export async function updateCodexLoginProfile(
  profileId: string,
  input: UpdateCodexProfileMetadataInput,
): Promise<CodexProfileObservationRowView> {
  return await patchJson<CodexProfileObservationRowView>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}`,
    input,
  );
}

export async function deleteCodexLoginProfile(profileId: string): Promise<{ profileId: string; status: "deleted" }> {
  return await postJson<{ profileId: string; status: "deleted" }>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}/delete`,
    { confirmed: true },
  );
}

export async function startCodexLoginProfileReLogin(profileId: string): Promise<CodexProfileLoginStartedView> {
  return await postJson<CodexProfileLoginStartedView>(
    `/api/codex/login-profiles/${encodeURIComponent(profileId)}/login-again`,
    {},
  );
}

export async function reorderCodexLoginProfiles(
  input: ReorderCodexProfilesInput,
): Promise<CodexProfileObservationListView> {
  return await putJson<CodexProfileObservationListView>("/api/codex/login-profiles/order", input);
}

export async function readCodexLoginProfileRefreshAll(): Promise<CodexProfileRefreshRunView> {
  return await requestJson<CodexProfileRefreshRunView>("/api/codex/login-profiles/refresh-all", {}, true);
}

export async function startCodexLoginProfileRefreshAll(): Promise<CodexProfileRefreshRunView> {
  return await postJson<CodexProfileRefreshRunView>("/api/codex/login-profiles/refresh-all", {});
}

export async function cancelCodexLoginProfileRefreshAll(): Promise<CodexProfileRefreshRunView> {
  return await deleteJson<CodexProfileRefreshRunView>("/api/codex/login-profiles/refresh-all");
}

export async function prepareCodexRedemption(
  input: LegacyPrepareCodexRedemptionInput,
): Promise<CodexRedemptionProposalView> {
  return await postJson<CodexRedemptionProposalView>("/api/codex/reset-redemptions/proposals", input);
}

export async function readCodexRedemptionState(proposalId: string): Promise<CodexRedemptionStateView> {
  return await requestJson<CodexRedemptionStateView>(
    `/api/codex/reset-redemptions/${encodeURIComponent(proposalId)}`,
    {},
    true,
  );
}

export async function readCurrentCodexRedemption(): Promise<CodexRedemptionCurrentView> {
  return await requestJson<CodexRedemptionCurrentView>(
    "/api/codex/reset-redemptions/current",
    {},
    true,
  );
}

export async function consumeCodexRedemption(proposalId: string): Promise<CodexRedemptionCurrentView> {
  return await requestJson<CodexRedemptionCurrentView>(
    `/api/codex/reset-redemptions/proposals/${encodeURIComponent(proposalId)}/consume`,
    { method: "POST" },
    true,
  );
}

export async function cancelCodexRedemption(
  proposalId: string,
): Promise<{ status: "cancelled"; proposalId: string }> {
  return await deleteJson(`/api/codex/reset-redemptions/proposals/${encodeURIComponent(proposalId)}`);
}

export async function putJson<T>(url: string, payload: unknown): Promise<T> {
  return await requestJson<T>(url, { method: "PUT", body: JSON.stringify(payload) }, true);
}

export async function patchJson<T>(url: string, payload: unknown): Promise<T> {
  return await requestJson<T>(url, { method: "PATCH", body: JSON.stringify(payload) }, true);
}

export async function deleteJson<T>(url: string): Promise<T> {
  return await requestJson<T>(url, { method: "DELETE" }, true);
}
