import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodexAccountUsageView } from "../shared/types.js";

import { CodexAccountGateway, CodexAccountGatewayError } from "./codex-account-gateway.js";
import type { CodexAccountUsageReader } from "./codex-app-account-usage.js";
import { startCodexAppServerSession } from "./codex-app-server-client.js";
import { resolveCodexBin } from "./commands.js";
import type { DashboardOptions } from "./types.js";

type JsonResponse = (res: ServerResponse, status: number, payload: unknown) => void;

export async function handleCodexApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  options: DashboardOptions,
  accountUsageService: CodexAccountUsageReader | undefined,
  jsonResponse: JsonResponse,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/codex/account-usage") {
    if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
      jsonResponse(res, 200, localOnlyView());
      return true;
    }
    if (!accountUsageService) {
      jsonResponse(res, 200, readFailedView());
      return true;
    }
    try {
      jsonResponse(res, 200, await accountUsageService.read(resolveCodexBin(options)));
    } catch {
      jsonResponse(res, 200, readFailedView());
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/codex/rate-limits") {
    let session: Awaited<ReturnType<typeof startCodexAppServerSession>> | null = null;
    try {
      session = await startCodexAppServerSession({ codexBin: resolveCodexBin(options) });
      const result = await new CodexAccountGateway(session).readRateLimits();
      jsonResponse(res, 200, { ok: true, availableCount: result.resetCredits?.availableCount ?? 0 });
    } catch (error) {
      if (error instanceof CodexAccountGatewayError && error.code === "authentication-required") {
        jsonResponse(res, 200, {
          ok: false,
          error: "authentication required",
          authRequired: true,
          availableCount: 0,
        });
      } else {
        jsonResponse(res, 500, { error: "Couldn't load Codex app usage." });
      }
    } finally {
      await session?.close();
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/codex/consume-reset") {
    jsonResponse(res, 403, {
      ok: false,
      error: "Reset-credit redemption is outside the retained quota snapshot story",
    });
    return true;
  }

  return false;
}

function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = (address ?? "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function baseUnavailable(message: string): CodexAccountUsageView {
  return {
    state: "runtime-unavailable",
    errorCode: "codex_runtime_unavailable",
    message,
    runtime: { status: "unavailable", version: null },
    account: null,
    observedAt: null,
    usage: null,
    resetCredits: null,
  };
}

function localOnlyView(): CodexAccountUsageView {
  return baseUnavailable("Codex app account data is available only from a loopback-local dashboard.");
}

function readFailedView(): CodexAccountUsageView {
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
