import type { ServerResponse } from "node:http";

import { CodexAccountGateway, CodexAccountGatewayError } from "./codex-account-gateway.js";
import { startCodexAppServerSession } from "./codex-app-server-client.js";
import { resolveCodexBin } from "./commands.js";
import type { DashboardOptions } from "./types.js";

type JsonResponse = (res: ServerResponse, status: number, payload: unknown) => void;

export async function handleCodexApi(
  res: ServerResponse,
  method: string,
  pathname: string,
  options: DashboardOptions,
  jsonResponse: JsonResponse,
): Promise<boolean> {
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
