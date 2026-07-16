import { describe, expect, it } from "vitest";

import type { CodexAccountUsageView } from "../../shared/types";
import { codexLoadingView, renderCodexAppAccount } from "./codex-app-account";

function view(overrides: Partial<CodexAccountUsageView> = {}): CodexAccountUsageView {
  return {
    state: "usage-ready-no-resets",
    errorCode: null,
    message: "No earned usage limit resets available.",
    runtime: { status: "qualified", version: "codex-cli 0.144.4" },
    account: { email: "operator@example.com", plan: "pro" },
    observedAt: "2026-07-16T12:00:00.000Z",
    usage: { primary: null, secondary: null },
    resetCredits: { availableCount: 0, selectionMode: "none", credits: [] },
    ...overrides,
  };
}

describe("Codex app account panel", () => {
  it("renders explicit permanent states with text and fixed retry copy", () => {
    expect(renderCodexAppAccount(codexLoadingView())).toContain("Loading Codex app usage…");
    expect(
      renderCodexAppAccount(
        view({
          state: "signed-out",
          errorCode: "codex_auth_required",
          message: "Sign in to Codex with ChatGPT, then refresh.",
          account: null,
          observedAt: null,
          usage: null,
          resetCredits: null,
        }),
      ),
    ).toContain("Sign in to Codex with ChatGPT, then refresh.");
    expect(
      renderCodexAppAccount(
        view({
          state: "runtime-incompatible",
          errorCode: "codex_runtime_incompatible",
          message: "Installed Codex does not expose the required usage-reset methods.",
          runtime: { status: "incompatible", version: null },
        }),
      ),
    ).toContain("Installed Codex does not expose the required usage-reset methods.");
    expect(
      renderCodexAppAccount(
        view({ state: "read-failed", errorCode: "codex_read_failed", message: "Couldn’t load Codex app usage." }),
      ),
    ).toContain('role="alert"');
  });

  it("escapes provider strings and renders keyboard-readable credit diagnostics", () => {
    const html = renderCodexAppAccount(
      view({
        state: "usage-ready-resets-available",
        message: "2 earned usage limit resets are available.",
        resetCredits: {
          availableCount: 2,
          selectionMode: "detailed",
          credits: [
            {
              id: "credit-1",
              availability: "available",
              title: "<script>alert(1)</script>",
              description: "Reset & continue",
              grantedAt: "2026-07-01T00:00:00.000Z",
              expiresAt: null,
            },
            {
              id: null,
              availability: "malformed",
              title: "Broken detail",
              description: null,
              grantedAt: null,
              expiresAt: null,
            },
          ],
        },
      }),
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Reset &amp; continue");
    expect(html).toContain("Does not expire");
    expect(html).toContain("Unavailable diagnostic");
    expect(html).toContain("<ul");
  });

    it("renders provider-selected generic reset context without enabling mutation", () => {
    const html = renderCodexAppAccount(
      view({
        state: "usage-ready-resets-available",
        resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
      }),
    );

      expect(html).toContain("Use a reset");
      expect(html).toContain("OpenAI will select the reset");
      expect(html).toContain("Redemption remains disabled");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("/consume");
    });

    it("does not label malformed expiry data as non-expiring", () => {
      const html = renderCodexAppAccount(
        view({
          state: "usage-ready-resets-available",
          resetCredits: {
            availableCount: 1,
            selectionMode: "generic",
            credits: [
              {
                id: null,
                availability: "malformed",
                title: "Invalid expiry detail",
                description: null,
                grantedAt: null,
                expiresAt: null,
              },
            ],
          },
        }),
      );

      expect(html).toContain("Expiry unavailable");
      expect(html).not.toContain("Does not expire");
    });

    it("shows account identity, both usage windows, observation time, and workspace warning", () => {
    const html = renderCodexAppAccount(
      view({
        usage: {
          primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2027-01-15T08:00:00.000Z" },
          secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: "2027-01-22T08:00:00.000Z" },
        },
      }),
    );

    expect(html).toContain("operator@example.com");
    expect(html).toContain("pro");
    expect(html).toContain("300 minutes");
    expect(html).toContain("10,080 minutes");
    expect(html).toContain("Observed");
    expect(html).toContain("do not prove which ChatGPT workspace owns a reset");
  });
});
