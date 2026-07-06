import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { handleApi } from "../api.js";
import { spawnCalls } from "./mock-child-process.js";
import {
  TEST_OPERATOR_TOKEN,
  accountFixture,
  makeMockRes,
  makeTempRoot,
  responseLogFixture,
  sameOriginHeaders,
  stubModelList,
  writeAccountFile,
  writeConfig,
  writeQuotaResponseLog,
} from "./helpers.js";


  describe("Codex rate limit reset feature API", () => {
      const options = {
        codexBin: "codex-test-bin",
        operatorToken: TEST_OPERATOR_TOKEN,
      };

    afterEach(() => {
      delete (globalThis as any).__mockCodexRateLimitsCount;
      delete (globalThis as any).__mockCodexAuthRequired;
      spawnCalls.length = 0;
    });

    const createMockReq = (method: string, urlPath: string, payload?: any) => {
        const req: any = {
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
    };

    const makeRes = () => {
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
        }
      } as unknown as ServerResponse;
      return {
        res,
        getStatus: () => status,
        getHeaders: () => headers,
        getBody: () => responseBody,
        getParsed: () => JSON.parse(responseBody),
      };
    };

    it("returns available count when Codex rateLimitResetCredits are read successfully", async () => {
      (globalThis as any).__mockCodexRateLimitsCount = 5;
      (globalThis as any).__mockCodexAuthRequired = false;

      const req = createMockReq("GET", "/api/codex/rate-limits");
      const mockRes = makeRes();

      const handled = await handleApi(req, mockRes.res, options);
      expect(handled).toBe(true);
      expect(mockRes.getStatus()).toBe(200);
      expect(mockRes.getParsed()).toEqual({ ok: true, availableCount: 5 });

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0].command).toBe("codex-test-bin");
      expect(spawnCalls[0].args).toEqual(["app-server", "--stdio"]);
    });

    it("returns authRequired true when Codex rate limits read fails with authentication required", async () => {
      (globalThis as any).__mockCodexRateLimitsCount = 0;
      (globalThis as any).__mockCodexAuthRequired = true;

      const req = createMockReq("GET", "/api/codex/rate-limits");
      const mockRes = makeRes();

      const handled = await handleApi(req, mockRes.res, options);
      expect(handled).toBe(true);
      expect(mockRes.getStatus()).toBe(200);
      expect(mockRes.getParsed().authRequired).toBe(true);
      expect(mockRes.getParsed().ok).toBe(false);
    });

    it("rejects rate limit reset credit redemption as out of scope", async () => {
      (globalThis as any).__mockCodexAuthRequired = false;

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

      expect(spawnCalls.length).toBe(0);
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
