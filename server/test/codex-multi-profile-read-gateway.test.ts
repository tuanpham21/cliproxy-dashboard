import { describe, expect, it, vi } from "vitest";

import { CodexMultiProfileReadGateway } from "../codex-multi-profile-read-gateway.js";
import type { CodexRuntimeQualifierLike } from "../codex-runtime-qualifier.js";
import {
  FakeCodexProcess,
  createFakeCodexSpawn,
  initializeFakeCodexProcess,
} from "./fake-codex-process.js";

describe("Codex multi-profile read gateway", () => {
  const qualifiedIdentity = {
    canonicalPath: "/trusted/bin/codex",
    codexStateRoot: "/private/codex-profiles/profile_A",
    codexSqliteRoot: "/private/codex-profiles/profile_A",
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4",
    schemaHash: "schema-hash",
  };

  function qualifiedRuntime(): CodexRuntimeQualifierLike {
    return {
      qualify: vi.fn(async () => ({ status: "qualified" as const, version: qualifiedIdentity.version, identity: qualifiedIdentity })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
  }

  it("refuses to start app-server when the selected profile runtime is not qualified", async () => {
    const runtimeContext = {
      codexStateRoot: "/private/codex-profiles/profile_A",
      codexSqliteRoot: "/private/codex-profiles/profile_A",
    };
    const qualifier: CodexRuntimeQualifierLike = {
      qualify: vi.fn(async () => ({
        status: "runtime-incompatible" as const,
        code: "codex_runtime_incompatible" as const,
        message: "Codex runtime or local state does not meet the required safety contract." as const,
      })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    const spawnProcess = vi.fn(() => {
      throw new Error("app-server must not start");
    });

    await expect(CodexMultiProfileReadGateway.start({
      codexBin: "/configured/bin/codex",
      runtimeContext,
      qualifier,
      spawnProcess,
    })).rejects.toThrow("Codex multi-profile read runtime is unavailable.");

    expect(qualifier.qualify).toHaveBeenCalledWith("/configured/bin/codex", runtimeContext);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("maps qualifier failures to a fixed error without spawning or exposing details", async () => {
    const qualifier = qualifiedRuntime();
    vi.mocked(qualifier.qualify).mockRejectedValueOnce(new Error("/private/root provider-secret"));
    const spawnProcess = vi.fn();

    const error = await CodexMultiProfileReadGateway.start({
      codexBin: "/configured/bin/codex",
      runtimeContext: {
        codexStateRoot: "/private/codex-profiles/profile_A",
        codexSqliteRoot: "/private/codex-profiles/profile_A",
      },
      qualifier,
      spawnProcess: spawnProcess as never,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ message: "Codex multi-profile read runtime is unavailable." });
    expect(String(error)).not.toContain("provider-secret");
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("exposes account and rate-limit reads without any reset-credit consume capability", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      const result = message.method === "account/read"
        ? {
            account: { type: "chatgpt", email: " operator@example.com ", planType: "pro" },
            requiresOpenaiAuth: false,
          }
        : {
            rateLimits: {
              primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1_800_000_000 },
              secondary: null,
            },
            rateLimitResetCredits: { availableCount: 2, credits: null },
          };
      process.sendJson({ jsonrpc: "2.0", id: message.id, result });
    });
    const spawnProcess = createFakeCodexSpawn(child);
    const gateway = await CodexMultiProfileReadGateway.start({
      codexBin: "/trusted/bin/codex",
      runtimeContext: {
        codexStateRoot: "/private/codex-profiles/profile_A",
        codexSqliteRoot: "/private/codex-profiles/profile_A",
      },
      qualifier: qualifiedRuntime(),
      spawnProcess,
    });

    await expect(gateway.readAccount()).resolves.toEqual({
      account: { type: "chatgpt", email: "operator@example.com", plan: "pro" },
      providerRequiresOpenAiAuth: false,
    });
    await expect(gateway.readRateLimits()).resolves.toMatchObject({
      rateLimits: { primary: { usedPercent: 12, windowMinutes: 300, resetsAt: 1_800_000_000 } },
      resetCredits: { availableCount: 2 },
    });
    expect(gateway).not.toHaveProperty("consumeResetCredit");
    expect(spawnProcess).toHaveBeenCalledWith(
      "/trusted/bin/codex",
      expect.arrayContaining(["app-server", "--stdio"]),
      expect.objectContaining({
        env: expect.objectContaining({
          CODEX_HOME: qualifiedIdentity.codexStateRoot,
          CODEX_SQLITE_HOME: qualifiedIdentity.codexSqliteRoot,
        }),
      }),
    );
    expect(child.writes.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "account/rateLimits/read",
    ]);

    await gateway.close();
  });

  it("closes and fails when the qualified runtime changes after app-server starts", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, () => {});
    const qualifier = qualifiedRuntime();
    vi.mocked(qualifier.matchesIdentity).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(CodexMultiProfileReadGateway.start({
      codexBin: "/configured/bin/codex",
      runtimeContext: {
        codexStateRoot: "/private/codex-profiles/profile_A",
        codexSqliteRoot: "/private/codex-profiles/profile_A",
      },
      qualifier,
      spawnProcess: createFakeCodexSpawn(child),
    })).rejects.toThrow("Codex multi-profile read runtime is unavailable.");

    expect(child.killed).toBe(true);
  });
});
