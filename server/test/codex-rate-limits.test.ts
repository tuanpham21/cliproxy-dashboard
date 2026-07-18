import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexAccountUsageView } from "../../shared/types.js";
import { handleApi } from "../api.js";
import {
  TEST_OPERATOR_TOKEN,
  sameOriginHeaders,
} from "./helpers.js";

type RateLimitUsageResult = Pick<CodexAccountUsageView, "state" | "errorCode" | "resetCredits">;

describe("Codex rate limit reset feature API", () => {
  let usageResult: RateLimitUsageResult;
  const readAccountUsage = vi.fn(async () => usageResult as CodexAccountUsageView);
  const options = {
    codexBin: "codex-test-bin",
    operatorToken: TEST_OPERATOR_TOKEN,
    codexAccountUsageService: { read: readAccountUsage },
  };

  beforeEach(() => {
    usageResult = {
      state: "usage-ready-resets-available",
      errorCode: null,
      resetCredits: { availableCount: 3, selectionMode: "count-only", credits: [] },
    };
    readAccountUsage.mockClear();
  });

  function createMockReq(method: string, urlPath: string, payload?: unknown): IncomingMessage {
    const req: Record<PropertyKey, unknown> = {
      method,
      url: urlPath,
      headers: sameOriginHeaders(true),
    };
    if (payload) {
      req[Symbol.asyncIterator] = async function* () {
        yield Buffer.from(JSON.stringify(payload));
      };
    }
    return req as IncomingMessage;
  }

  function makeRes() {
    let status = 0;
    let headers: Record<string, string> = {};
    let responseBody = "";
    const res = {
      writeHead: (code: number, hdrs: Record<string, string>) => {
        status = code;
        headers = hdrs;
      },
      end: (body: string) => {
        responseBody = body;
      },
    } as unknown as ServerResponse;
    return {
      res,
      getStatus: () => status,
      getHeaders: () => headers,
      getBody: () => responseBody,
      getParsed: () => JSON.parse(responseBody),
    };
  }

  it("returns available count when Codex rateLimitResetCredits are read successfully", async () => {
    usageResult = {
      state: "usage-ready-resets-available",
      errorCode: null,
      resetCredits: { availableCount: 5, selectionMode: "count-only", credits: [] },
    };

    const req = createMockReq("GET", "/api/codex/rate-limits");
    const mockRes = makeRes();

    const handled = await handleApi(req, mockRes.res, options);
    expect(handled).toBe(true);
    expect(mockRes.getStatus()).toBe(200);
    expect(mockRes.getParsed()).toEqual({ ok: true, availableCount: 5 });

    expect(readAccountUsage).toHaveBeenCalledWith("codex-test-bin");
  });

  it("returns authRequired true when Codex rate limits require authentication", async () => {
    usageResult = {
      state: "signed-out",
      errorCode: "codex_auth_required",
      resetCredits: null,
    };

    const req = createMockReq("GET", "/api/codex/rate-limits");
    const mockRes = makeRes();

    const handled = await handleApi(req, mockRes.res, options);
    expect(handled).toBe(true);
    expect(mockRes.getStatus()).toBe(200);
    expect(mockRes.getParsed().authRequired).toBe(true);
    expect(mockRes.getParsed().ok).toBe(false);
  });

  it("returns sanitized available count when credit details are unavailable", async () => {
    usageResult = {
      state: "usage-ready-resets-available",
      errorCode: null,
      resetCredits: { availableCount: 2, selectionMode: "count-only", credits: [] },
    };

    const req = createMockReq("GET", "/api/codex/rate-limits");
    const mockRes = makeRes();

    await handleApi(req, mockRes.res, options);
    expect(mockRes.getStatus()).toBe(200);
    expect(mockRes.getParsed()).toEqual({ ok: true, availableCount: 2 });
  });

  it("rejects rate limit reset credit redemption as out of scope", async () => {
    const req = createMockReq("POST", "/api/codex/consume-reset", {
      idempotencyKey: "test-uuid-v4-key",
    });
    const mockRes = makeRes();

    const handled = await handleApi(req, mockRes.res, options);
    expect(handled).toBe(true);
    expect(mockRes.getStatus()).toBe(403);
    expect(mockRes.getParsed()).toEqual({
      ok: false,
      error: "Reset-credit redemption is outside the retained quota snapshot story",
    });

    expect(readAccountUsage).not.toHaveBeenCalled();
  });

  it("rejects reset redemption even when idempotencyKey is missing", async () => {
    const req = createMockReq("POST", "/api/codex/consume-reset", {});
    const mockRes = makeRes();

    const handled = await handleApi(req, mockRes.res, options);
    expect(handled).toBe(true);
    expect(mockRes.getStatus()).toBe(403);
    expect(mockRes.getParsed().error).toContain("outside the retained quota snapshot story");
  });
});
