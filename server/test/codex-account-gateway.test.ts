import { describe, expect, it } from "vitest";

import { startCodexAppServerSession } from "../codex-app-server-client.js";
import { CodexAccountGateway, CodexAccountGatewayError } from "../codex-account-gateway.js";
import {
  FakeCodexProcess,
  createFakeCodexSpawn,
  initializeFakeCodexProcess,
} from "./fake-codex-process.js";

async function gatewayFor(responses: Record<string, unknown>) {
  const child = new FakeCodexProcess();
  initializeFakeCodexProcess(child, (message, acknowledge, process) => {
    acknowledge();
    process.sendJson({ jsonrpc: "2.0", id: message.id, result: responses[String(message.method)] });
  });
  const session = await startCodexAppServerSession({
    codexBin: "codex",
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
      requiresOpenAiAuth: false,
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

    await expect(gateway.readAccount()).resolves.toEqual({ account: null, requiresOpenAiAuth: true });
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
});
