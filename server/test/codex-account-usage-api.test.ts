import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { CodexAccountUsageView } from "../../shared/types.js";
import { handleApi } from "../api.js";
import type { CodexAccountUsageReader } from "../codex-app-account-usage.js";
import { TEST_OPERATOR_TOKEN, makeMockRes, sameOriginHeaders } from "./helpers.js";

const readyView: CodexAccountUsageView = {
  state: "usage-ready-no-resets",
  errorCode: null,
  message: "No earned usage limit resets available.",
  runtime: { status: "qualified", version: "codex-cli 0.144.4" },
  account: { email: "operator@example.com", plan: "pro" },
  observedAt: "2026-07-16T12:00:00.000Z",
  usage: { primary: null, secondary: null },
  resetCredits: { availableCount: 0, selectionMode: "none", credits: [] },
};

function request(remoteAddress: string): IncomingMessage {
  return {
    method: "GET",
    url: "/api/codex/account-usage",
    headers: sameOriginHeaders(true),
    socket: { remoteAddress },
  } as unknown as IncomingMessage;
}

function readerWith(view: CodexAccountUsageView): CodexAccountUsageReader & { read: ReturnType<typeof vi.fn> } {
  return { read: vi.fn(async () => view) };
}

describe("Codex app account usage API", () => {
  it("returns one stable public view for a loopback listener and caller", async () => {
    const reader = readerWith(readyView);
    const mockRes = makeMockRes();

    const handled = await handleApi(request("::ffff:127.0.0.1"), mockRes.res as ServerResponse, {
      host: "127.0.0.1",
      codexBin: "/opt/codex/bin/codex",
      operatorToken: TEST_OPERATOR_TOKEN,
      codexAccountUsageService: reader,
    });

    expect(handled).toBe(true);
    expect(mockRes.getStatus()).toBe(200);
    expect(mockRes.getParsed()).toEqual(readyView);
    expect(reader.read).toHaveBeenCalledWith("/opt/codex/bin/codex");
  });

  it.each([
    ["non-loopback listener", "0.0.0.0", "127.0.0.1"],
    ["non-loopback caller", "127.0.0.1", "10.0.0.8"],
  ])("fails closed for %s without starting Codex", async (_name, host, remoteAddress) => {
    const reader = readerWith(readyView);
    const mockRes = makeMockRes();

    await handleApi(request(remoteAddress), mockRes.res as ServerResponse, {
      host,
      operatorToken: TEST_OPERATOR_TOKEN,
      codexAccountUsageService: reader,
    });

    expect(mockRes.getStatus()).toBe(200);
    expect(mockRes.getParsed()).toEqual({
      state: "runtime-unavailable",
      errorCode: "codex_runtime_unavailable",
      message: "Codex app account data is available only from a loopback-local dashboard.",
      runtime: { status: "unavailable", version: null },
      account: null,
      observedAt: null,
      usage: null,
      resetCredits: null,
    });
    expect(reader.read).not.toHaveBeenCalled();
  });

  it("maps an unexpected service failure to fixed read-failed copy", async () => {
    const reader: CodexAccountUsageReader = {
      read: vi.fn(async () => Promise.reject(new Error("/private/path provider-secret"))),
    };
    const mockRes = makeMockRes();

    await handleApi(request("127.0.0.1"), mockRes.res as ServerResponse, {
      host: "127.0.0.1",
      operatorToken: TEST_OPERATOR_TOKEN,
      codexAccountUsageService: reader,
    });

    expect(mockRes.getParsed()).toMatchObject({
      state: "read-failed",
      errorCode: "codex_read_failed",
      message: "Couldn’t load Codex app usage.",
    });
    expect(JSON.stringify(mockRes.getParsed())).not.toContain("provider-secret");
  });

  it("includes browser-safe active proposal context for reconnect discovery", async () => {
    const reader = readerWith(readyView);
    const mockRes = makeMockRes();
    const activeRedemption = {
      status: "prepared" as const,
      proposalId: "p".repeat(43),
      allowedAction: "cancel" as const,
      createdAt: "2026-07-16T12:00:00.000Z",
      expiresAt: "2026-07-16T12:02:00.000Z",
      account: { email: "operator@example.com", plan: "pro" },
      usage: { primary: null, secondary: null },
      availableCount: 1,
      selection: { mode: "generic" as const },
    };

    await handleApi(request("127.0.0.1"), mockRes.res as ServerResponse, {
      host: "127.0.0.1",
      operatorToken: TEST_OPERATOR_TOKEN,
      codexAccountUsageService: reader,
      codexRedemptionService: {
        currentState: vi.fn(async () => activeRedemption),
        prepare: vi.fn(),
        state: vi.fn(),
        cancel: vi.fn(),
        close: vi.fn(async () => {}),
      },
    });

    expect(mockRes.getParsed()).toEqual({ ...readyView, activeRedemption });
  });
});
