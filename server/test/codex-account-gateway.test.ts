import { describe, expect, it } from "vitest";

import { startCodexAppServerSession } from "../codex-app-server-client.js";
import { CodexAccountGateway, CodexAccountGatewayError } from "../codex-account-gateway.js";
import {
  FakeCodexProcess,
  createFakeCodexSpawn,
  initializeFakeCodexProcess,
} from "./fake-codex-process.js";

const runtimeContext = {
  codexStateRoot: "/private/test-codex-state",
  codexSqliteRoot: "/private/test-codex-sqlite",
};

async function gatewayFor(responses: Record<string, unknown>) {
  const child = new FakeCodexProcess();
  initializeFakeCodexProcess(child, (message, acknowledge, process) => {
    acknowledge();
    process.sendJson({ jsonrpc: "2.0", id: message.id, result: responses[String(message.method)] });
  });
  const session = await startCodexAppServerSession({
    codexBin: "codex",
    runtimeContext,
    spawnProcess: createFakeCodexSpawn(child),
  });
  return { gateway: new CodexAccountGateway(session), session, child };
}

describe("Codex account gateway", () => {
  it("normalizes account and full rate-limit responses through typed methods", async () => {
    const { gateway, session, child } = await gatewayFor({
      "account/read": {
        account: { type: "chatgpt", email: " operator@example.com ", planType: "pro" },
        requiresOpenaiAuth: false,
      },
      "account/rateLimits/read": {
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 25.5, windowMinutes: 300, resetsAt: 1_800_000_000 },
          secondary: null,
          planType: "pro",
        },
        rateLimitsByLimitId: null,
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "credit-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_700_000_000,
              expiresAt: null,
              title: "Reset",
              description: "Reset eligible limits",
            },
          ],
        },
      },
    });

    await expect(gateway.readAccount()).resolves.toEqual({
      account: { type: "chatgpt", email: "operator@example.com", plan: "pro" },
      providerRequiresOpenAiAuth: false,
    });
    await expect(gateway.readRateLimits()).resolves.toMatchObject({
      rateLimits: {
        primary: { usedPercent: 25.5, windowMinutes: 300, resetsAt: 1_800_000_000 },
        secondary: null,
        plan: "pro",
      },
      resetCredits: {
        availableCount: 2,
        credits: [{ id: "credit-1", status: "available", expiresAt: null }],
      },
    });
    expect(child.writes.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
    ]);
    await session.close();
  });

  it("preserves signed-out account state and absent reset-credit details", async () => {
    const { gateway, session } = await gatewayFor({
      "account/read": { account: null, requiresOpenaiAuth: true },
      "account/rateLimits/read": {
        rateLimits: { primary: null, secondary: null },
        rateLimitResetCredits: null,
      },
    });

    await expect(gateway.readAccount()).resolves.toEqual({ account: null, providerRequiresOpenAiAuth: true });
    await expect(gateway.readRateLimits()).resolves.toMatchObject({ resetCredits: null });
    await session.close();
  });

  it.each([
    ["fractional count", { availableCount: 1.5, credits: null }],
    ["negative count", { availableCount: -1, credits: null }],
    ["string count", { availableCount: "2", credits: null }],
  ])("fails closed for malformed reset-credit payload: %s", async (_name, resetCredits) => {
    const { gateway, session } = await gatewayFor({
      "account/rateLimits/read": { rateLimits: {}, rateLimitResetCredits: resetCredits },
    });

    const result = gateway.readRateLimits();
    await expect(result).rejects.toBeInstanceOf(CodexAccountGatewayError);
    await expect(result).rejects.toMatchObject({ code: "invalid-response" });
    await session.close();
  });

  it("maps authentication errors to a stable typed code without raw provider text", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      process.sendJson({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32001, message: "authentication required: secret-provider-detail" },
      });
    });
      const session = await startCodexAppServerSession({
        codexBin: "codex",
        runtimeContext,
        spawnProcess: createFakeCodexSpawn(child),
    });
    const gateway = new CodexAccountGateway(session);

    const result = gateway.readRateLimits();
    await expect(result).rejects.toMatchObject({
      name: "CodexAccountGatewayError",
      code: "authentication-required",
      message: "Codex authentication is required.",
    });
    await expect(result).rejects.not.toHaveProperty("message", expect.stringContaining("secret-provider-detail"));
    await session.close();
  });

  it("preserves valid reset count while marking malformed credit details unavailable", async () => {
    const { gateway, session } = await gatewayFor({
      "account/rateLimits/read": {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "credit-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_700_000_000,
              expiresAt: "invalid",
              title: "Reset",
              description: null,
            },
          ],
        },
      },
    });

    await expect(gateway.readRateLimits()).resolves.toMatchObject({
      resetCredits: {
        availableCount: 2,
        credits: [{ id: "credit-1", expiresAt: null, availability: "malformed" }],
      },
    });
    await session.close();
  });

  it.each(["reset", "alreadyRedeemed", "nothingToReset", "noCredit"] as const)(
    "normalizes consume outcome %s with server-owned request fields",
    async (outcome) => {
      const { gateway, session, child } = await gatewayFor({
        "account/rateLimitResetCredit/consume": { outcome },
      });

      await expect(gateway.consumeResetCredit({
        idempotencyKey: "11111111-2222-4333-8444-555555555555",
        creditId: "credit-1",
        timeoutMs: 20_000,
      })).resolves.toEqual({ outcome });
      expect(child.writes.at(-1)).toMatchObject({
        method: "account/rateLimitResetCredit/consume",
        params: {
          idempotencyKey: "11111111-2222-4333-8444-555555555555",
          creditId: "credit-1",
        },
      });
      await session.close();
    },
  );

  it("preserves consume transport write disposition and rejects unknown outcomes", async () => {
    const unknown = await gatewayFor({
      "account/rateLimitResetCredit/consume": { outcome: "provider-added-value" },
    });
    await expect(unknown.gateway.consumeResetCredit({ idempotencyKey: "key" })).rejects.toMatchObject({
      code: "invalid-response",
    });
    await unknown.session.close();

    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      if (message.method === "account/rateLimitResetCredit/consume") process.closeWith(1);
      else process.sendJson({ jsonrpc: "2.0", id: message.id, result: {} });
    });
      const session = await startCodexAppServerSession({ codexBin: "codex", runtimeContext, spawnProcess: createFakeCodexSpawn(child) });
    const gateway = new CodexAccountGateway(session);
    await expect(gateway.consumeResetCredit({ idempotencyKey: "key" })).rejects.toMatchObject({
      code: "transport-failed",
      writeDisposition: "possibly-written",
    });
    await session.close();
  });

  it("omits creditId for generic consume", async () => {
    const { gateway, session, child } = await gatewayFor({
      "account/rateLimitResetCredit/consume": { outcome: "reset" },
    });
    await gateway.consumeResetCredit({ idempotencyKey: "server-key" });
    expect(child.writes.at(-1)?.params).toEqual({ idempotencyKey: "server-key" });
    await session.close();
  });
});
