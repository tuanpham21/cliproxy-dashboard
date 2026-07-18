import type { IncomingMessage, ServerResponse } from "node:http";
import type { CodexAccountUsageView } from "../shared/types.js";
import type { PrepareCodexRedemptionInput } from "../shared/codex-account-types.js";
import { isCodexRedemptionProposalId } from "../shared/codex-redemption-identifiers.js";

import type { CodexAccountUsageReader } from "./codex-app-account-usage.js";
import { resolveCodexBin } from "./commands.js";
import {
  CodexRedemptionServiceError,
  type CodexRedemptionController,
} from "./codex-redemption-service.js";
import type { DashboardOptions } from "./types.js";

type JsonResponse = (res: ServerResponse, status: number, payload: unknown) => void;

export async function handleCodexApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  options: DashboardOptions,
  accountUsageService: CodexAccountUsageReader | undefined,
  redemptionService: CodexRedemptionController | undefined,
  jsonResponse: JsonResponse,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/codex/reset-redemptions/current") {
    if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
      jsonResponse(res, 403, {
        code: "codex_runtime_unavailable",
        error: "Reset redemption is available only from a loopback-local dashboard.",
      });
      return true;
    }
    if (!redemptionService) {
      jsonResponse(res, 503, { code: "codex_read_failed", error: "Couldn’t load reset redemption state." });
      return true;
    }
      try {
        jsonResponse(res, 200, await redemptionService.currentState());
      } catch (error) {
        respondRedemptionError(res, error, jsonResponse);
      }
      return true;
    }
    const polledProposalId = method === "GET"
    ? proposalIdFromPath(pathname, "/api/codex/reset-redemptions/")
    : null;
  if (polledProposalId) {
    if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
      jsonResponse(res, 403, {
        code: "codex_runtime_unavailable",
        error: "Reset redemption is available only from a loopback-local dashboard.",
      });
      return true;
    }
    if (!redemptionService) {
      jsonResponse(res, 503, { code: "codex_read_failed", error: "Couldn’t load reset redemption state." });
      return true;
    }
    try {
      jsonResponse(res, 200, await redemptionService.state(polledProposalId));
    } catch (error) {
      respondRedemptionError(res, error, jsonResponse);
    }
    return true;
  }

  const cancelledProposalId = method === "DELETE"
    ? proposalIdFromPath(pathname, "/api/codex/reset-redemptions/proposals/")
    : null;
  if (cancelledProposalId) {
    if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
      jsonResponse(res, 403, {
        code: "codex_runtime_unavailable",
        error: "Reset redemption is available only from a loopback-local dashboard.",
      });
      return true;
    }
    if (!redemptionService) {
      jsonResponse(res, 503, { code: "codex_read_failed", error: "Couldn’t cancel reset redemption." });
      return true;
    }
    try {
      await assertEmptyBody(req, 512);
      jsonResponse(res, 200, await redemptionService.cancel(cancelledProposalId));
    } catch (error) {
      respondRedemptionError(res, error, jsonResponse);
    }
    return true;
  }

  const consumeMatch = method === "POST"
    ? pathname.match(/^\/api\/codex\/reset-redemptions\/proposals\/([A-Za-z0-9_-]{43})\/consume$/)
    : null;
  if (consumeMatch) {
    if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
      jsonResponse(res, 403, {
        code: "codex_runtime_unavailable",
        error: "Reset redemption is available only from a loopback-local dashboard.",
      });
      return true;
    }
    if (!redemptionService) {
      jsonResponse(res, 503, { code: "codex_read_failed", error: "Couldn’t redeem reset." });
      return true;
    }
    try {
      await assertEmptyBody(req, 512);
        jsonResponse(res, 200, await redemptionService.consume(consumeMatch[1], resolveCodexBin(options)));
    } catch (error) {
      respondRedemptionError(res, error, jsonResponse, "Couldn’t redeem reset.");
    }
    return true;
  }

  if (method === "POST" && pathname === "/api/codex/reset-redemptions/proposals") {
    if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
      jsonResponse(res, 403, {
        code: "codex_runtime_unavailable",
        error: "Reset redemption is available only from a loopback-local dashboard.",
      });
      return true;
    }
    if (!redemptionService) {
      jsonResponse(res, 503, { code: "codex_read_failed", error: "Couldn’t prepare reset redemption." });
      return true;
    }
    try {
      const input = parsePrepareBody(await readBoundedJson(req, 2_048));
      jsonResponse(res, 201, await redemptionService.prepare(resolveCodexBin(options), input));
    } catch (error) {
      respondRedemptionError(res, error, jsonResponse);
    }
    return true;
  }

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
      const view = await accountUsageService.read(resolveCodexBin(options));
      const activeRedemption = redemptionService ? await redemptionService.currentState() : undefined;
      jsonResponse(res, 200, activeRedemption ? { ...view, activeRedemption } : view);
    } catch {
      jsonResponse(res, 200, readFailedView());
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/codex/rate-limits") {
    if (!accountUsageService) {
      jsonResponse(res, 500, { error: "Couldn't load Codex app usage." });
      return true;
    }
    try {
      const result = await accountUsageService.read(resolveCodexBin(options));
      if (result.state === "signed-out") {
        jsonResponse(res, 200, {
          ok: false,
          error: "authentication required",
          authRequired: true,
          availableCount: 0,
        });
      } else if (result.resetCredits) {
        jsonResponse(res, 200, { ok: true, availableCount: result.resetCredits.availableCount });
      } else {
        jsonResponse(res, 500, { error: "Couldn't load Codex app usage." });
      }
    } catch {
      jsonResponse(res, 500, { error: "Couldn't load Codex app usage." });
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

function proposalIdFromPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const proposalId = pathname.slice(prefix.length);
  return isCodexRedemptionProposalId(proposalId) ? proposalId : null;
}

class CodexRedemptionRequestError extends Error {
  readonly code: "redemption-invalid-request";

  constructor() {
    super("Reset redemption request is invalid.");
    this.name = "CodexRedemptionRequestError";
    this.code = "redemption-invalid-request";
  }
}

async function readBoundedJson(req: IncomingMessage, maximumBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.byteLength;
    if (bytes > maximumBytes) throw new CodexRedemptionRequestError();
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new CodexRedemptionRequestError();
  }
}

async function assertEmptyBody(req: IncomingMessage, maximumBytes: number): Promise<void> {
  let bytes = 0;
  for await (const chunk of req) {
    bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bytes > maximumBytes || bytes > 0) throw new CodexRedemptionRequestError();
  }
}

function parsePrepareBody(value: unknown): PrepareCodexRedemptionInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CodexRedemptionRequestError();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "creditId" && key !== "singleWorkspaceAttested")) {
    throw new CodexRedemptionRequestError();
  }
  if (record.singleWorkspaceAttested !== true) {
    throw new CodexRedemptionServiceError("redemption-attestation-required");
  }
  if (record.creditId === undefined) return { singleWorkspaceAttested: true };
  if (
    typeof record.creditId !== "string" ||
    record.creditId.length === 0 ||
    Buffer.byteLength(record.creditId, "utf8") > 512
  ) {
    throw new CodexRedemptionRequestError();
  }
  return { creditId: record.creditId, singleWorkspaceAttested: true };
}

function respondRedemptionError(res: ServerResponse, error: unknown, jsonResponse: JsonResponse, fallback = "Couldn’t prepare reset redemption."): void {
  if (error instanceof CodexRedemptionRequestError) {
    jsonResponse(res, 400, { code: error.code, error: error.message });
    return;
  }
  if (error instanceof CodexRedemptionServiceError) {
    const status = error.code === "redemption-proposal-not-found"
      ? 404
      : error.code === "redemption-proposal-active" || error.code === "redemption-recovery-required" ||
            error.code === "codex_account_changed" || error.code === "codex_reset_availability_changed" ||
            error.code === "codex_session_changed" || error.code === "codex_recovery_account_mismatch" ||
            error.code === "codex_proposal_expired"
        ? 409
        : error.code === "codex_read_failed" || error.code === "redemption-private-state-unavailable"
          ? 503
          : 400;
    jsonResponse(res, status, { code: error.code, error: error.message });
    return;
  }
  jsonResponse(res, 503, { code: "codex_read_failed", error: fallback });
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
