import type { DashboardState, RateLimitState } from "../../shared/types";

const TOKEN_PLACEHOLDER = "__CLIPROXY_OPERATOR_TOKEN__";
const OPERATOR_TOKEN_HEADER = "x-cliproxy-dashboard-token";

let operatorTokenPromise: Promise<string> | null = null;

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
    throw new Error(detail);
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

export async function putJson<T>(url: string, payload: unknown): Promise<T> {
  return await requestJson<T>(url, { method: "PUT", body: JSON.stringify(payload) }, true);
}

export async function deleteJson<T>(url: string): Promise<T> {
  return await requestJson<T>(url, { method: "DELETE" }, true);
}
