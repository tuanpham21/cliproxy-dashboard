import { randomUUID } from "node:crypto";
import { access, copyFile, mkdir, unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import { mutateAccountFile, normalizeAccount, parseJwtExp, promotePrimary, publicAccount, setAccountPatch } from "./accounts.js";
import { cleanupStuckOauthLogins, queryCodexAppServer, resolveCliProxyBin, resolveCodexBin, startOauthLogin } from "./commands.js";
import { DEFAULT_BACKUP_PRIORITY, DEFAULT_CONFIG_PATH, DEFAULT_PRIORITY, DEFAULT_TEST_MODEL, DEFAULT_TEST_OUTPUT_TOKENS, DEFAULT_TEST_PROMPT, DASHBOARD_OPERATOR_TOKEN_HEADER } from "./constants.js";
import { publicConfig, setRoutingConfig } from "./config.js";
import { readDashboardState } from "./dashboard-state.js";
import { atomicWriteText, readJsonObject } from "./files.js";
import { readLatestCodexSelection } from "./logs.js";
import { resolveAccountPath, resolveDashboardPaths } from "./paths.js";
import type { RotationCoordinator } from "./rotation-coordinator.js";
import { coordinateManualRoutingAction, handleRotationApi } from "./rotation-api.js";
import type { CodexSelectionLogLine, DashboardOptions, DashboardPaths, TestRequestOptions } from "./types.js";
import { asHeaderValue, asString, isRecord } from "./util.js";

export async function pingProxy(proxyUrl: string, inboundKey: string | null): Promise<boolean> {
  if (!inboundKey) {
    return false;
  }
  try {
    const response = await fetch(`${proxyUrl}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${inboundKey}`,
        Accept: "application/json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function sendTestRequest(
  paths: DashboardPaths,
  options: TestRequestOptions,
): Promise<{
  requestId: string;
  ok: boolean;
  status: number;
  responseText: string;
  latestCodexSelection: CodexSelectionLogLine | null;
}> {
  if (!paths.inboundKey) {
    throw new Error("No inbound proxy key was found in config.yaml");
  }
  const requestId = randomUUID();
  const model = options.model?.trim() || DEFAULT_TEST_MODEL;
  const prompt = options.prompt?.trim() || DEFAULT_TEST_PROMPT;
  const maxOutputTokens = Number.isFinite(options.maxOutputTokens ?? NaN)
    ? Math.max(1, Math.trunc(options.maxOutputTokens ?? DEFAULT_TEST_OUTPUT_TOKENS))
    : DEFAULT_TEST_OUTPUT_TOKENS;
  const response = await fetch(`${paths.proxyUrl}/v1/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${paths.inboundKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Client-Request-Id": requestId,
    },
    body: JSON.stringify({
      model,
      input: prompt,
      max_output_tokens: maxOutputTokens,
      stream: false,
    }),
  });
  const responseText = await response.text();
  const latestCodexSelection = await readLatestCodexSelection(paths.logsDir);
  return {
    requestId,
    ok: response.ok,
    status: response.status,
    responseText: responseText.slice(0, 4000),
    latestCodexSelection,
  };
}

export function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

export function textResponse(
  res: ServerResponse,
  statusCode: number,
  text: string,
  contentType = "text/plain; charset=utf-8",
): void {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function hostnameFromHostHeader(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isSafeDashboardHostname(hostname: string, configuredHost?: string): boolean {
  const normalized = hostname.toLowerCase();
  if (normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]") {
    return true;
  }
  if (!configuredHost || configuredHost === "0.0.0.0" || configuredHost === "::") {
    return false;
  }
  return normalized === configuredHost.toLowerCase();
}

export function isSameOriginRequest(req: IncomingMessage, options: Pick<DashboardOptions, "host"> = {}): boolean {
  const headers = req.headers ?? {};
  const fetchSite = asHeaderValue(headers["sec-fetch-site"]).toLowerCase();
  const origin = asHeaderValue(headers.origin).trim();
  const host = asHeaderValue(headers.host).trim();
  const hostname = hostnameFromHostHeader(host);
  if (!hostname || !isSafeDashboardHostname(hostname, options.host)) {
    return false;
  }
  if (origin) {
    if (!host || origin !== `http://${host}`) {
      return false;
    }
  }
  if (fetchSite) {
    return fetchSite === "same-origin" || fetchSite === "none";
  }
  return Boolean(origin);
}

export function requiresOperatorToken(method: string, pathname: string): boolean {
  if (!pathname.startsWith("/api/")) {
    return false;
  }
  return !(method === "GET" && (pathname === "/api/state" || pathname === "/api/bootstrap"));
}

export function hasValidOperatorToken(req: IncomingMessage, options: DashboardOptions): boolean {
  const expected = options.operatorToken;
  if (!expected) {
    return false;
  }
  return asHeaderValue(req.headers?.[DASHBOARD_OPERATOR_TOKEN_HEADER]).trim() === expected;
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  options: DashboardOptions & { rotationCoordinator?: RotationCoordinator | null },
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments[0] === "api" && !isSameOriginRequest(req, options)) {
    jsonResponse(res, 403, { error: "same-origin dashboard request required" });
    return true;
  }
  if (requiresOperatorToken(method, url.pathname) && !hasValidOperatorToken(req, options)) {
    jsonResponse(res, 403, { error: "valid dashboard operator token required" });
    return true;
  }

  if (await handleRotationApi(req, res, method, url.pathname, segments, options.rotationCoordinator)) return true;

  if (method === "GET" && url.pathname === "/api/state") {
    jsonResponse(res, 200, { ...(await readDashboardState(options)), rotation: options.rotationCoordinator?.publicState() });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/bootstrap") {
    jsonResponse(res, 200, { operatorToken: options.operatorToken ?? "" });
    return true;
  }

  if (method === "GET" && url.pathname === "/api/codex/rate-limits") {
    const codexBin = resolveCodexBin(options);
    try {
      const result = await queryCodexAppServer(codexBin, "account/rateLimits/read", {});
      const rawResult = result as any;
      const availableCount =
        typeof rawResult?.rateLimitResetCredits?.availableCount === "number" ||
        typeof rawResult?.rateLimitResetCredits?.availableCount === "bigint"
          ? Number(rawResult.rateLimitResetCredits.availableCount)
          : 0;
      jsonResponse(res, 200, { ok: true, availableCount });
    } catch (err: any) {
      if (err.message && err.message.includes("authentication required")) {
        jsonResponse(res, 200, { ok: false, error: err.message, authRequired: true, availableCount: 0 });
      } else {
        jsonResponse(res, 500, { error: err.message || String(err) });
      }
    }
    return true;
  }

  if (method === "POST" && url.pathname === "/api/codex/consume-reset") {
    jsonResponse(res, 403, {
      ok: false,
      error: "Reset-credit redemption is outside the retained quota snapshot story",
    });
    return true;
  }

  if (method === "POST" && url.pathname === "/api/routing") {
    const body = await readJsonBody(req);
    const strategy = typeof body.strategy === "string" ? body.strategy.trim() : "";
    const sessionAffinity =
      typeof body.sessionAffinity === "boolean" ? body.sessionAffinity : false;
    if (!strategy) {
      jsonResponse(res, 400, { error: "routing.strategy is required" });
      return true;
    }
    await coordinateManualRoutingAction(options.rotationCoordinator, "Routing configuration changed by operator");
    const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
    const updated = await setRoutingConfig(configPath, { strategy, sessionAffinity });
    await options.rotationCoordinator?.refreshReadiness();
    jsonResponse(res, 200, { ok: true, config: publicConfig(updated) });
    return true;
  }

  if (method === "POST" && segments[0] === "api" && segments[1] === "test-request") {
    const body = await readJsonBody(req);
    const resolved = await resolveDashboardPaths(options);
    const result = await sendTestRequest(resolved, {
      model: typeof body.model === "string" ? body.model : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      maxOutputTokens: typeof body.maxOutputTokens === "number" ? body.maxOutputTokens : undefined,
    });
    jsonResponse(res, 200, result);
    return true;
  }

  if (method === "POST" && segments[0] === "api" && segments[1] === "accounts" && segments[2] === "login-oauth") {
    const body = (await readJsonBody(req).catch(() => ({}))) as any;
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const resolved = await resolveDashboardPaths(options);

    try {
      await cleanupStuckOauthLogins();
      const url = await startOauthLogin(resolved.configPath, email, resolveCliProxyBin(options));
      jsonResponse(res, 200, { ok: true, url, message: "OAuth login URL generated" });
    } catch (error) {
      jsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  if (method === "POST" && segments[0] === "api" && segments[1] === "accounts" && segments.length === 2) {
    const body = await readJsonBody(req);
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const plan = typeof body.plan === "string" ? body.plan.trim() : "";
    if (!email) {
      jsonResponse(res, 400, { error: "email is required" });
      return true;
    }
    if (!plan) {
      jsonResponse(res, 400, { error: "plan is required" });
      return true;
    }
    if (!/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(email)) {
      jsonResponse(res, 400, { error: "invalid email format" });
      return true;
    }
    if (!/^[a-zA-Z0-9-_]+$/.test(plan)) {
      jsonResponse(res, 400, { error: "invalid plan format" });
      return true;
    }

    const resolved = await resolveDashboardPaths(options);
    const disabled = typeof body.disabled === "boolean" ? body.disabled : false;
    const priority =
      typeof body.priority === "number" && Number.isFinite(body.priority)
        ? Math.trunc(body.priority)
        : DEFAULT_PRIORITY;
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const accountId = typeof body.account_id === "string" ? body.account_id.trim() : "";
    const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
    const idToken = typeof body.id_token === "string" ? body.id_token.trim() : "";
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token.trim() : "";
    const expired = typeof body.expired === "string" ? body.expired.trim() : "";
    const lastRefresh = typeof body.last_refresh === "string" ? body.last_refresh.trim() : new Date().toISOString();

    const baseName = `codex-${email}-${plan}.json`;
    const targetFileName = disabled ? `${baseName}.disabled` : baseName;
    const targetPath = resolveAccountPath(resolved.authDir, targetFileName);

    let fileExists = false;
    try {
      await access(resolveAccountPath(resolved.authDir, baseName));
      fileExists = true;
    } catch {}
    try {
      await access(resolveAccountPath(resolved.authDir, `${baseName}.disabled`));
      fileExists = true;
    } catch {}

    if (fileExists) {
      jsonResponse(res, 400, { error: `Account file for ${email} with plan ${plan} already exists` });
      return true;
    }

    const payload: Record<string, unknown> = {
      email,
      priority,
      disabled,
      note,
      account_id: accountId,
      access_token: accessToken,
      id_token: idToken,
      refresh_token: refreshToken,
      expired,
      last_refresh: lastRefresh,
      type: "codex",
    };

    if (!accessToken) delete payload.access_token;
    if (!idToken) delete payload.id_token;
    if (!refreshToken) delete payload.refresh_token;

    await atomicWriteText(targetPath, `${JSON.stringify(payload, null, 2)}\n`);
    const account = normalizeAccount(targetPath, payload);
    jsonResponse(res, 201, { ok: true, account: publicAccount(account) });
    return true;
  }

  if (segments[0] === "api" && segments[1] === "accounts" && segments[2]) {
    const fileName = decodeURIComponent(segments[2]);
    const resolved = await resolveDashboardPaths(options);
      if ((method === "PATCH" || method === "POST") && segments.length === 3) {
      const body = await readJsonBody(req);
      const priority =
        body.priority === null
          ? null
          : typeof body.priority === "number" && Number.isFinite(body.priority)
            ? Math.trunc(body.priority)
            : undefined;
      const note =
        body.note === null ? null : typeof body.note === "string" ? body.note : undefined;
        const disabled =
        body.disabled === null
          ? null
          : typeof body.disabled === "boolean"
              ? body.disabled
              : undefined;
        if (priority !== undefined || disabled !== undefined) {
          await coordinateManualRoutingAction(options.rotationCoordinator, `Proxy Account changed manually: ${fileName}`);
        }
      const account = await setAccountPatch(resolved.authDir, resolved.backupRoot, fileName, {
        priority,
        note,
        disabled,
      });
      jsonResponse(res, 200, { ok: true, account: publicAccount(account) });
      return true;
    }
      if (method === "POST" && segments[3] === "primary") {
        await coordinateManualRoutingAction(options.rotationCoordinator, `Manual Primary selected: ${fileName}`);
      const body = await readJsonBody(req);
      const backupPriority =
        typeof body.backupPriority === "number" && Number.isFinite(body.backupPriority)
          ? Math.trunc(body.backupPriority)
          : DEFAULT_BACKUP_PRIORITY;
      await promotePrimary(resolved.authDir, resolved.backupRoot, fileName, backupPriority);
      jsonResponse(res, 200, { ok: true });
      return true;
    }
      if (method === "POST" && segments[3] === "backup") {
        await coordinateManualRoutingAction(options.rotationCoordinator, `Manual backup priority selected: ${fileName}`);
      const account = await setAccountPatch(resolved.authDir, resolved.backupRoot, fileName, {
        priority: DEFAULT_BACKUP_PRIORITY,
        note: "backup",
      });
      jsonResponse(res, 200, { ok: true, account: publicAccount(account) });
      return true;
    }
      if (method === "POST" && segments[3] === "clear-priority") {
        await coordinateManualRoutingAction(options.rotationCoordinator, `Manual priority cleared: ${fileName}`);
      const account = await setAccountPatch(resolved.authDir, resolved.backupRoot, fileName, {
        priority: null,
      });
      jsonResponse(res, 200, { ok: true, account: publicAccount(account) });
      return true;
    }
      if (method === "DELETE" && segments.length === 3) {
        await coordinateManualRoutingAction(options.rotationCoordinator, `Proxy Account deleted manually: ${fileName}`);
      const filePath = resolveAccountPath(resolved.authDir, fileName);
      let exists = false;
      try {
        await access(filePath);
        exists = true;
      } catch {}
      if (!exists) {
        jsonResponse(res, 404, { error: `Account not found: ${fileName}` });
        return true;
      }
      try {
        await mkdir(resolved.backupRoot, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const backupName = `${fileName}.deleted-${ts}`;
        await copyFile(filePath, path.join(resolved.backupRoot, backupName));
      } catch {}
      await unlink(filePath);
      jsonResponse(res, 200, { ok: true, deleted: fileName });
      return true;
    }
    if (method === "POST" && segments[3] === "verify") {
      const filePath = resolveAccountPath(resolved.authDir, fileName);
      let raw: Record<string, unknown> | null = null;
      try {
        raw = await readJsonObject(filePath);
      } catch {}
      if (!raw) {
        jsonResponse(res, 404, { error: `Account not found: ${fileName}` });
        return true;
      }

      const accessToken = asString(raw.access_token, "");
      const refreshToken = asString(raw.refresh_token, "");

      let isValid = false;
      let verifyErrorMsg = "";

      if (accessToken) {
        try {
          const modelRes = await fetch("https://api.openai.com/v1/models", {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
          });
          if (modelRes.status === 200) {
            isValid = true;
          } else {
            const errText = await modelRes.text().catch(() => "");
            verifyErrorMsg = `Token invalid (HTTP ${modelRes.status}): ${errText.slice(0, 100)}`;
          }
        } catch (err) {
          verifyErrorMsg = `Network error during token check: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else {
        verifyErrorMsg = "No access token present";
      }

      if (!isValid && refreshToken) {
        try {
          const refreshRes = await fetch("https://auth.openai.com/oauth/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              grant_type: "refresh_token",
              client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
              refresh_token: refreshToken,
            }),
          });

          if (refreshRes.ok) {
            const tokenData = (await refreshRes.json()) as any;
            if (tokenData && tokenData.access_token) {
              isValid = true;
              const nextAccessToken = tokenData.access_token;
              const nextRefreshToken = tokenData.refresh_token || refreshToken;
              const nextIdToken = tokenData.id_token || raw.id_token || "";

              let nextExpired = "";
              const expFromJwt = parseJwtExp(nextAccessToken);
              if (expFromJwt) {
                nextExpired = expFromJwt;
              } else if (typeof tokenData.expires_in === "number") {
                nextExpired = new Date(Date.now() + tokenData.expires_in * 1000).toISOString();
              } else {
                nextExpired = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
              }

              const updated = await mutateAccountFile(resolved.authDir, resolved.backupRoot, fileName, (acc) => {
                acc.access_token = nextAccessToken;
                acc.refresh_token = nextRefreshToken;
                if (nextIdToken) {
                  acc.id_token = nextIdToken;
                }
                acc.expired = nextExpired;
                acc.last_refresh = new Date().toISOString();
                acc.validity_status = "valid";
                acc.validation_error = "";
              });

              jsonResponse(res, 200, { ok: true, valid: true, refreshed: true, account: publicAccount(updated) });
              return true;
            } else {
              verifyErrorMsg = "OAuth response was missing access_token";
            }
          } else {
            const errJson = (await refreshRes.json().catch(() => ({}))) as any;
            const errDescription = errJson?.error_description || errJson?.error || await refreshRes.text().catch(() => "");
            verifyErrorMsg = `Session has ended (${errDescription || refreshRes.statusText})`;
          }
        } catch (err) {
          verifyErrorMsg = `Network error during token refresh: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      const targetStatus = isValid ? "valid" : "invalid";
      const updated = await mutateAccountFile(resolved.authDir, resolved.backupRoot, fileName, (acc) => {
        acc.validity_status = targetStatus;
        acc.validation_error = isValid ? "" : verifyErrorMsg;
      });

      jsonResponse(res, 200, {
        ok: true,
        valid: isValid,
        refreshed: false,
        error: isValid ? undefined : verifyErrorMsg,
        account: publicAccount(updated)
      });
      return true;
    }
  }

  return false;
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  return isRecord(parsed) ? parsed : {};
}
