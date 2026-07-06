import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import { handleApi } from "../api.js";
import { readDashboardState } from "../dashboard-state.js";
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


describe("cliproxy dashboard account workflows and logs", () => {
  it("tracks the latest Codex selection from the service log", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const configPath = path.join(root, "config.yaml");
    await mkdir(logsDir, { recursive: true });

    const stevenFileName = "codex-stevencakrawala@noriet.biz.id-plus.json";
    const tuanFileName = "codex-tuanpham.work21@gmail.com-plus.json";
    await writeFile(
      path.join(authDir, stevenFileName),
      `${JSON.stringify(
        {
          email: "stevencakrawala@noriet.biz.id",
          priority: 100,
          disabled: false,
          account_id: "abcdef12-3456-7890-abcd-ef1234567890",
          type: "codex",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(authDir, tuanFileName),
      `${JSON.stringify(
        {
          email: "tuanpham.work21@gmail.com",
          priority: 10,
          disabled: false,
          account_id: "12345678-90ab-cdef-1234-567890abcdef",
          type: "codex",
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      configPath,
      [
        "port: 8317",
        `auth-dir: ${authDir}`,
        "api-keys:",
        "  - codex-proxy-key",
        "routing:",
        "  strategy: fill-first",
        "  session-affinity: false",
        "",
      ].join("\n"),
    );
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gpt-5.4-mini", owned_by: "openai", created: 1773705600, object: "model" },
              {
                id: "claude-opus-4.6",
                owned_by: "anthropic",
                created: 1778993447,
                object: "model",
              },
              { id: "gpt-5.4", owned_by: "openai", created: 1772668800, object: "model" },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    await writeFile(
      path.join(logsDir, "main.log"),
      [
        "[2026-05-17 10:37:28] [1e39afb0] [info ] [selector.go:500] session-affinity: cache hit | session=msg:7c64a28cedf23af7 auth=claude:apikey:1234 provider=mixed model=claude-opus-4.6",
        `[2026-05-17 10:37:29] [1e39afb1] [info ] [selector.go:500] session-affinity: cache miss, new binding | session=msg:593c79004589d8ee auth=${tuanFileName} provider=mixed model=gpt-5.4-mini`,
        `[2026-05-17 10:37:30] [e4102fbf] [info ] [gin_logger.go:94] 200 |        3.958s |       127.0.0.1 | POST    "/v1/responses"`,
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(logsDir, "v1-responses-2026-05-17T115100-0f8b0632.log"),
      responseLogFixture(tuanFileName, {
        timestamp: "2026-05-17T11:51:00.758479+07:00",
      }),
    );
    await writeFile(
      path.join(logsDir, "v1-responses-2026-05-17T115120-0eaa9117.log"),
      responseLogFixture(stevenFileName, {
        timestamp: "2026-05-17T11:51:15.447929+07:00",
      }),
    );

    const state = await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "codex-proxy-key",
    });

    expect(state.paths.authDir).toBe(authDir);
    expect(state.logSummary.latestSelection?.auth).toBe(tuanFileName);
    expect(state.selectedAccount?.fileName).toBe(stevenFileName);
    expect(state.logSummary.latestCodexSelection?.auth).toBe(stevenFileName);
    expect(state.models.map((model) => model.id)).toEqual([
      "claude-opus-4.6",
      "gpt-5.4",
      "gpt-5.4-mini",
    ]);
    expect(state.logSummary.latestRequest?.path).toBe("/v1/responses");
    expect(state.config ? "raw" in state.config : false).toBe(false);
    expect(state.selectedAccount ? "raw" in state.selectedAccount : false).toBe(false);
    expect(state.accounts.some((account) => "raw" in account)).toBe(false);
  });

  it("manually registers new codex accounts", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const backupRoot = path.join(root, "backups");
    await mkdir(authDir, { recursive: true });

    // Mock options
      const options = {
        configPath: path.join(root, "config.yaml"),
        authDir,
        backupRoot,
        operatorToken: TEST_OPERATOR_TOKEN,
      };

    // Helper to mock request
      const createMockReq = (payload: any) => ({
        method: "POST",
        url: "/api/accounts",
        headers: sameOriginHeaders(true),
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify(payload));
        }
    } as unknown as IncomingMessage);

    // Helper to mock response
    let status = 0;
    let headers: Record<string, string> = {};
    let responseBody = "";
    const createMockRes = () => ({
      writeHead: (code: number, hdrs: Record<string, string>) => {
        status = code;
        headers = hdrs;
      },
      end: (body: string) => {
        responseBody = body;
      }
    } as unknown as ServerResponse);

    // 1. Success case
    const payload = {
      email: "new-user@example.com",
      plan: "plus",
      priority: 250,
      note: "newly added",
      account_id: "1234-abcd",
      access_token: "mock-access",
      disabled: false,
    };

    const res1 = createMockRes();
    const handled1 = await handleApi(createMockReq(payload), res1, options);
    expect(handled1).toBe(true);
    expect(status).toBe(201);
    const parsed1 = JSON.parse(responseBody);
    expect(parsed1.ok).toBe(true);
    expect(parsed1.account.email).toBe("new-user@example.com");
    expect(parsed1.account.plan).toBe("plus");
    expect(parsed1.account.priority).toBe(250);

    // Verify written file exists
    const fileText = await readFile(path.join(authDir, "codex-new-user@example.com-plus.json"), "utf8");
    const parsedDisk = JSON.parse(fileText);
    expect(parsedDisk).toMatchObject({
      email: "new-user@example.com",
      priority: 250,
      note: "newly added",
      account_id: "1234-abcd",
      access_token: "mock-access",
      disabled: false,
      type: "codex",
    });

    // 2. Duplicate case
    const res2 = createMockRes();
    const handled2 = await handleApi(createMockReq(payload), res2, options);
    expect(handled2).toBe(true);
    expect(status).toBe(400);
    const parsed2 = JSON.parse(responseBody);
    expect(parsed2.error).toContain("already exists");

    // 3. Validation case: invalid email
    const badPayload1 = { ...payload, email: "not-an-email" };
    const res3 = createMockRes();
    const handled3 = await handleApi(createMockReq(badPayload1), res3, options);
    expect(handled3).toBe(true);
    expect(status).toBe(400);
    expect(JSON.parse(responseBody).error).toContain("invalid email");

    // 4. Validation case: invalid plan
    const badPayload2 = { ...payload, email: "another@example.com", plan: "bad/plan" };
    const res4 = createMockRes();
    const handled4 = await handleApi(createMockReq(badPayload2), res4, options);
    expect(handled4).toBe(true);
    expect(status).toBe(400);
    expect(JSON.parse(responseBody).error).toContain("invalid plan");
  });

  it("triggers OAuth login workflow", async () => {
    const root = await makeTempRoot();
      const options = {
        configPath: path.join(root, "config.yaml"),
        authDir: path.join(root, "auth"),
        backupRoot: path.join(root, "backups"),
        cliProxyBin: "C:\\Tools\\cli-proxy-api\\cli-proxy-api.exe",
        operatorToken: TEST_OPERATOR_TOKEN,
      };

      const req = {
        method: "POST",
        url: "/api/accounts/login-oauth",
        headers: sameOriginHeaders(true),
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({ email: "test@example.com" }));
        }
    } as unknown as IncomingMessage;

    let status = 0;
    let responseBody = "";
    const res = {
      writeHead: (code: number) => {
        status = code;
      },
      end: (body: string) => {
        responseBody = body;
      }
    } as unknown as ServerResponse;

    const handled = await handleApi(req, res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    const parsed = JSON.parse(responseBody);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toContain("https://auth.openai.com/oauth/authorize");
    expect(parsed.url).toContain("login_hint=test%40example.com");
    expect(spawnCalls.some((call) => call.command === options.cliProxyBin)).toBe(true);
  });

  it("verifies and refreshes Codex account tokens via verify endpoint", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const backupRoot = path.join(root, "backups");
    await mkdir(authDir, { recursive: true });

      const options = {
        configPath: path.join(root, "config.yaml"),
        authDir,
        backupRoot,
        operatorToken: TEST_OPERATOR_TOKEN,
      };

    // Helper to mock request
      const createMockReq = () => ({
        method: "POST",
        url: "/api/accounts/codex-test%40example.com-plus.json/verify",
        headers: sameOriginHeaders(true),
        [Symbol.asyncIterator]: async function* () {
          yield Buffer.from(JSON.stringify({}));
        }
    } as unknown as IncomingMessage);

    let status = 0;
    let responseBody = "";
    const createMockRes = () => ({
      writeHead: (code: number) => {
        status = code;
      },
      end: (body: string) => {
        responseBody = body;
      }
    } as unknown as ServerResponse);

    // Write a mock account file
    const accountFile = path.join(authDir, "codex-test@example.com-plus.json");
    await writeFile(
      accountFile,
      JSON.stringify({
        email: "test@example.com",
        access_token: "old-access-token",
        refresh_token: "old-refresh-token",
        expired: "",
        last_refresh: "",
        type: "codex",
      }, null, 2)
    );

    // 1. Success case: access token is valid (fetch to v1/models returns 200)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url === "https://api.openai.com/v1/models") {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response("", { status: 404 });
      })
    );

    let res = createMockRes();
    let handled = await handleApi(createMockReq(), res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    let body = JSON.parse(responseBody);
    expect(body.valid).toBe(true);
    expect(body.refreshed).toBe(false);

    // Verify written file has validity_status = "valid"
    let fileJson = JSON.parse(await readFile(accountFile, "utf8"));
    expect(fileJson.validity_status).toBe("valid");

    // 2. Refresh case: access token is invalid (401), but refresh token is valid (returns new tokens)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url === "https://api.openai.com/v1/models") {
          return new Response("", { status: 401 });
        }
        if (url === "https://auth.openai.com/oauth/token") {
          // Verify request body is correct
          const body = JSON.parse(init.body);
          expect(body.grant_type).toBe("refresh_token");
          expect(body.refresh_token).toBe("old-refresh-token");

          // Note: parts[1] is base64url encoded payload: {"exp": 1780000000} -> eyJleHAiOjE3ODAwMDAwMDB9
          return new Response(
            JSON.stringify({
              access_token: "header.eyJleHAiOjE3ODAwMDAwMDB9.sig",
              refresh_token: "new-refresh-token",
              expires_in: 86400,
            }),
            { status: 200 }
          );
        }
        return new Response("", { status: 404 });
      })
    );

    res = createMockRes();
    handled = await handleApi(createMockReq(), res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    body = JSON.parse(responseBody);
    expect(body.valid).toBe(true);
    expect(body.refreshed).toBe(true);

    fileJson = JSON.parse(await readFile(accountFile, "utf8"));
    expect(fileJson.access_token).toBe("header.eyJleHAiOjE3ODAwMDAwMDB9.sig");
    expect(fileJson.refresh_token).toBe("new-refresh-token");
    expect(fileJson.validity_status).toBe("valid");
    expect(fileJson.expired).toBe(new Date(1780000000 * 1000).toISOString());

    // 3. Failed case: both access token and refresh token are invalid (session ended)
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init: any) => {
        if (url === "https://api.openai.com/v1/models") {
          return new Response("", { status: 401 });
        }
        if (url === "https://auth.openai.com/oauth/token") {
          return new Response(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Your session has ended.",
            }),
            { status: 400 }
          );
        }
        return new Response("", { status: 404 });
      })
    );

    res = createMockRes();
    handled = await handleApi(createMockReq(), res, options);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    body = JSON.parse(responseBody);
    expect(body.valid).toBe(false);
    expect(body.refreshed).toBe(false);
    expect(body.error).toContain("Session has ended");

    fileJson = JSON.parse(await readFile(accountFile, "utf8"));
    expect(fileJson.validity_status).toBe("invalid");
    expect(fileJson.validation_error).toContain("Session has ended");
  });

  it("decodes the id_token JWT for ChatGPT subscription quota and plan details", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    await mkdir(authDir, { recursive: true });

    const fileName = "codex-test@example.com-plus.json";
    const filePath = path.join(authDir, fileName);

    // Mock ID token with standard chatgpt subscription details
    // header: eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9
    // payload: {"https://api.openai.com/auth": {"chatgpt_plan_type": "plus", "chatgpt_subscription_active_until": "2026-10-16T16:59:35+00:00"}}
    const mockIdToken = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9wbGFuX3R5cGUiOiJwbHVzIiwiY2hhdGdwdF9zdWJzY3JpcHRpb25fYWN0aXZlX3VudGlsIjoiMjAyNi0xMC0xNlQxNjo1OTozNSswMDowMCJ9fQ.sig";

    await writeFile(
      filePath,
      JSON.stringify({
        email: "test@example.com",
        id_token: mockIdToken,
        type: "codex",
      })
    );

    const configPath = path.join(root, "config.yaml");
    await writeFile(
      configPath,
      [
        "port: 8317",
        `auth-dir: ${authDir}`,
        "api-keys:",
        "  - key",
        "",
      ].join("\n")
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
        }
        return new Response("", { status: 404 });
      })
    );

    const state = await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "key",
    });

    const account = state.accounts.find((a) => a.email === "test@example.com");
    expect(account).toBeDefined();
    expect(account?.subscriptionPlan).toBe("plus");
    expect(account?.subscriptionActiveUntil).toBe("2026-10-16T16:59:35+00:00");
  });

  it("parses and extracts subscription quota headers from responses logs", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    await mkdir(logsDir, { recursive: true });

    const fileName = "codex-test@example.com-plus.json";
    const filePath = path.join(authDir, fileName);

    await writeFile(
      filePath,
      JSON.stringify({
        email: "test@example.com",
        type: "codex",
      })
    );

    // Write a mock responses log file with Codex headers
    await writeFile(
      path.join(logsDir, "v1-responses-2026-06-07T190000-abcd.log"),
      [
        "=== REQUEST INFO ===",
        "Timestamp: 2026-06-07T19:00:00.000Z",
        "=== API REQUEST 1 ===",
        `Auth: provider=codex, auth_id=${fileName}, label=test, type=oauth`,
        "X-Codex-Primary-Used-Percent: 35",
        "X-Codex-Primary-Reset-After-Seconds: 3600",
        "X-Codex-Secondary-Used-Percent: 12",
        "X-Codex-Secondary-Reset-After-Seconds: 86400",
      ].join("\n")
    );

    const configPath = path.join(root, "config.yaml");
    await writeFile(
      configPath,
      [
        "port: 8317",
        `auth-dir: ${authDir}`,
        "api-keys:",
        "  - key",
        "",
      ].join("\n")
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith("/v1/models")) {
          return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
        }
        return new Response("", { status: 404 });
      })
    );

    const state = await readDashboardState({
      configPath,
      proxyUrl: "http://proxy.local",
      inboundKey: "key",
    });

    const account = state.accounts.find((a) => a.email === "test@example.com");
    expect(account).toBeDefined();
    expect(account?.quota.primary5h.usedPercent).toBe(35);
    expect(account?.quota.weekly.usedPercent).toBe(12);
  });

});
