import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexAccountUsageView } from "../../shared/types";

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

describe("Codex account usage API client", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("preserves the stable server state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ operatorToken: "token" }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(readyView), { status: 200 })),
    );
    const { readCodexAccountUsage } = await import("./api");

    await expect(readCodexAccountUsage()).resolves.toEqual(readyView);
  });

  it("maps network failure to fixed read-failed state", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ operatorToken: "token" }), { status: 200 }))
        .mockRejectedValueOnce(new Error("private network detail")),
    );
    const { readCodexAccountUsage } = await import("./api");

    const result = await readCodexAccountUsage();
    expect(result).toMatchObject({
      state: "read-failed",
      errorCode: "codex_read_failed",
      message: "Couldn’t load Codex app usage.",
    });
    expect(JSON.stringify(result)).not.toContain("private network detail");
  });
});
