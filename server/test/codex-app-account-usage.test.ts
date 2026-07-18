import { describe, expect, it, vi } from "vitest";

import { CodexAppAccountUsageService } from "../codex-app-account-usage.js";
import { startCodexAppServerSession } from "../codex-app-server-client.js";
import type { CodexRuntimeQualification, CodexRuntimeQualifierLike } from "../codex-runtime-qualifier.js";
import {
  FakeCodexProcess,
  createFakeCodexSpawn,
  initializeFakeCodexProcess,
} from "./fake-codex-process.js";

const qualified: CodexRuntimeQualification = {
  status: "qualified",
  version: "codex-cli 0.144.4",
  identity: {
    canonicalPath: "/opt/codex/bin/codex",
    codexStateRoot: "/home/operator/.codex",
    codexSqliteRoot: "/home/operator/.codex/sqlite",
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4",
    schemaHash: "a".repeat(64),
  },
};

const authenticationRequired = Symbol("authentication-required");

function qualifierWith(result: CodexRuntimeQualification): CodexRuntimeQualifierLike {
  return {
    qualify: vi.fn(async () => result),
    matchesIdentity: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
}

async function serviceHarness(
  responses: Record<string, unknown>,
  qualification: CodexRuntimeQualification = qualified,
) {
  const child = new FakeCodexProcess();
  initializeFakeCodexProcess(child, (message, acknowledge, process) => {
    acknowledge();
    const response = responses[String(message.method)];
    if (response === authenticationRequired) {
      process.sendJson({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "authentication required" } });
    } else if (response instanceof Error) {
      process.sendJson({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: response.message } });
    } else {
      process.sendJson({ jsonrpc: "2.0", id: message.id, result: response });
    }
  });
  const startSession = vi.fn(async ({ codexBin, runtimeContext }: {
    codexBin: string;
    runtimeContext: { codexStateRoot: string; codexSqliteRoot: string };
  }) => await startCodexAppServerSession({ codexBin, runtimeContext, spawnProcess: createFakeCodexSpawn(child) }));
  const service = new CodexAppAccountUsageService({
    qualifier: qualifierWith(qualification),
    startSession,
    now: () => new Date("2026-07-16T12:00:00.000Z"),
  });
  return { service, child, startSession };
}

describe("Codex app account usage service", () => {
  it("returns qualified account, usage windows, reset details, and ISO timestamps", async () => {
    const { service, child, startSession } = await serviceHarness({
      "account/read": {
        account: { type: "chatgpt", email: "operator@example.com", planType: "pro" },
        requiresOpenaiAuth: true,
      },
      "account/rateLimits/read": {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 60, windowDurationMins: 10_080, resetsAt: 1_800_604_800 },
        },
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "credit-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_700_000_000,
              expiresAt: 1_900_000_000,
              title: "<Reset & continue>",
              description: "Provider chooses eligible windows.",
            },
          ],
        },
      },
    });

    await expect(service.read("codex")).resolves.toMatchObject({
      state: "usage-ready-resets-available",
      errorCode: null,
      runtime: { status: "qualified", version: "codex-cli 0.144.4" },
      account: { email: "operator@example.com", plan: "pro" },
      observedAt: "2026-07-16T12:00:00.000Z",
      usage: {
        primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2027-01-15T08:00:00.000Z" },
        secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: "2027-01-22T08:00:00.000Z" },
      },
      resetCredits: {
        availableCount: 2,
        selectionMode: "detailed",
        credits: [
          {
            id: "credit-1",
            availability: "available",
            grantedAt: "2023-11-14T22:13:20.000Z",
            expiresAt: "2030-03-17T17:46:40.000Z",
            title: "<Reset & continue>",
          },
        ],
      },
    });
    expect(startSession).toHaveBeenCalledWith({
      codexBin: "/opt/codex/bin/codex",
      runtimeContext: {
        codexStateRoot: "/home/operator/.codex",
        codexSqliteRoot: "/home/operator/.codex/sqlite",
      },
    });
    expect(child.killed).toBe(true);
  });

  it("truncates provider text at UTF-8 boundaries", async () => {
    const { service } = await serviceHarness({
      "account/read": {
        account: { type: "chatgpt", email: "operator@example.com", planType: "pro" },
        requiresOpenaiAuth: false,
      },
      "account/rateLimits/read": {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: "credit-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_700_000_000,
              expiresAt: null,
              title: `${"a".repeat(255)}😀`,
              description: `${"b".repeat(2047)}😀`,
            },
          ],
        },
      },
    });

    const result = await service.read("codex");
    const credit = result.resetCredits?.credits[0];
    expect(credit?.title).toBe("a".repeat(255));
    expect(credit?.description).toBe("b".repeat(2047));
    expect(credit?.title).not.toContain("�");
    expect(credit?.description).not.toContain("�");
  });

  it("returns generic provider selection when count is positive without usable details", async () => {
    const { service } = await serviceHarness({
      "account/read": {
        account: { type: "chatgpt", email: "operator@example.com", planType: "plus" },
        requiresOpenaiAuth: false,
      },
      "account/rateLimits/read": {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 1,
          credits: [
            {
              id: "credit-1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_700_000_000,
              expiresAt: "invalid",
              title: "Unavailable detail",
              description: null,
            },
          ],
        },
      },
    });

    await expect(service.read("codex")).resolves.toMatchObject({
      state: "usage-ready-resets-available",
      resetCredits: {
        availableCount: 1,
        selectionMode: "generic",
        credits: [{ availability: "malformed" }],
      },
    });
  });

    it("sorts usable reset details by earliest expiry with non-expiring credits last", async () => {
    const { service } = await serviceHarness({
      "account/read": {
        account: { type: "chatgpt", email: "operator@example.com", planType: "pro" },
        requiresOpenaiAuth: false,
      },
      "account/rateLimits/read": {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 3,
          credits: [
            { id: "no-expiry", resetType: "codexRateLimits", status: "available", grantedAt: 1_700_000_000, expiresAt: null },
            { id: "late", resetType: "codexRateLimits", status: "available", grantedAt: 1_700_000_000, expiresAt: 1_900_000_000 },
            { id: "early", resetType: "codexRateLimits", status: "available", grantedAt: 1_700_000_000, expiresAt: 1_800_000_000 },
          ],
        },
      },
    });

    const result = await service.read("codex");
      expect(result.resetCredits?.credits.map((credit) => credit.id)).toEqual(["early", "late", "no-expiry"]);
    });

    it("prioritizes usable reset details before applying the public detail cap", async () => {
      const { service } = await serviceHarness({
        "account/read": {
          account: { type: "chatgpt", email: "operator@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        },
        "account/rateLimits/read": {
          rateLimits: {},
          rateLimitResetCredits: {
            availableCount: 1,
            credits: [
              ...Array.from({ length: 128 }, () => ({})),
              { id: "usable", resetType: "codexRateLimits", status: "available", grantedAt: 1_700_000_000, expiresAt: null },
            ],
          },
        },
      });

      const result = await service.read("codex");
      expect(result.resetCredits?.selectionMode).toBe("detailed");
      expect(result.resetCredits?.credits).toHaveLength(128);
      expect(result.resetCredits?.credits[0]).toMatchObject({ id: "usable", availability: "available" });
    });

  it.each([
    [
      "signed-out",
      { account: null, requiresOpenaiAuth: true },
      "signed-out",
      "codex_auth_required",
      "Sign in to Codex with ChatGPT, then refresh.",
    ],
    [
      "missing email",
      { account: { type: "chatgpt", email: "  ", planType: "pro" }, requiresOpenaiAuth: false },
      "identity-incomplete",
      "codex_identity_incomplete",
      "Codex did not provide an email and known plan. Redemption is unavailable.",
    ],
    [
      "unknown plan",
      { account: { type: "chatgpt", email: "operator@example.com", planType: "unknown" }, requiresOpenaiAuth: false },
      "identity-incomplete",
      "codex_identity_incomplete",
      "Codex did not provide an email and known plan. Redemption is unavailable.",
    ],
  ])("maps %s to a stable public state", async (_name, accountResponse, state, errorCode, message) => {
    const { service } = await serviceHarness({
      "account/read": accountResponse,
      "account/rateLimits/read": { rateLimits: {}, rateLimitResetCredits: null },
    });

    await expect(service.read("codex")).resolves.toMatchObject({ state, errorCode, message });
  });

  it("maps qualifier and gateway failures to fixed public states", async () => {
    const unavailable = await serviceHarness({}, {
      status: "runtime-unavailable",
      code: "codex_runtime_unavailable",
      message: "Codex runtime unavailable. Check the configured Codex path.",
    });
    await expect(unavailable.service.read("codex")).resolves.toMatchObject({
      state: "runtime-unavailable",
      errorCode: "codex_runtime_unavailable",
    });

    const incompatible = await serviceHarness({}, {
      status: "runtime-incompatible",
      code: "codex_runtime_incompatible",
      message: "Codex runtime or local state does not meet the required safety contract.",
    });
    await expect(incompatible.service.read("codex")).resolves.toMatchObject({
      state: "runtime-incompatible",
      errorCode: "codex_runtime_incompatible",
    });

    const failed = await serviceHarness({
      "account/read": new Error("provider secret body"),
    });
    const result = await failed.service.read("codex");
    expect(result).toMatchObject({
      state: "read-failed",
      errorCode: "codex_read_failed",
      message: "Couldn’t load Codex app usage.",
    });
    expect(JSON.stringify(result)).not.toContain("provider secret body");

    const authenticationFailure = await serviceHarness({
      "account/read": {
        account: { type: "chatgpt", email: "operator@example.com", planType: "pro" },
        requiresOpenaiAuth: false,
      },
      "account/rateLimits/read": authenticationRequired,
    });
    await expect(authenticationFailure.service.read("codex")).resolves.toMatchObject({
      state: "signed-out",
      errorCode: "codex_auth_required",
      message: "Sign in to Codex with ChatGPT, then refresh.",
    });
  });

  it("fails closed when the qualified binary identity changes before or after session start", async () => {
    const beforeSession = {
      qualify: vi.fn(async () => qualified),
      matchesIdentity: vi.fn(async () => false),
      close: vi.fn(async () => {}),
    } satisfies CodexRuntimeQualifierLike;
    const beforeService = new CodexAppAccountUsageService({ qualifier: beforeSession, startSession: vi.fn() });
    await expect(beforeService.read("codex")).resolves.toMatchObject({
      state: "runtime-incompatible",
      errorCode: "codex_runtime_incompatible",
      runtime: { status: "incompatible", version: null },
    });

    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (_message, acknowledge) => acknowledge());
    const afterSession = {
      qualify: vi.fn(async () => qualified),
      matchesIdentity: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      close: vi.fn(async () => {}),
    } satisfies CodexRuntimeQualifierLike;
    const startSession = vi.fn(async () => await startCodexAppServerSession({
      codexBin: qualified.identity.canonicalPath,
      runtimeContext: qualified.identity,
      spawnProcess: createFakeCodexSpawn(child),
    }));
    const afterService = new CodexAppAccountUsageService({ qualifier: afterSession, startSession });

    await expect(afterService.read("codex")).resolves.toMatchObject({
      state: "runtime-incompatible",
      errorCode: "codex_runtime_incompatible",
      runtime: { status: "incompatible", version: null },
    });
    expect(startSession).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(true);
  });
});
