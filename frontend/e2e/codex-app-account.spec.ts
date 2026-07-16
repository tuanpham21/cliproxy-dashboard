import { expect, test, type Page } from "@playwright/test";

type UsageView = {
  state: string;
  errorCode: string | null;
  message: string;
  runtime: { status: string; version: string | null };
  account: { email: string | null; plan: string | null } | null;
  observedAt: string | null;
  usage: {
    primary: { usedPercent: number | null; durationMinutes: number | null; resetsAt: string | null } | null;
    secondary: { usedPercent: number | null; durationMinutes: number | null; resetsAt: string | null } | null;
  } | null;
  resetCredits: {
    availableCount: number;
    selectionMode: "none" | "detailed" | "generic";
    credits: Array<{
      id: string | null;
      availability: string;
      title: string | null;
      description: string | null;
      grantedAt: string | null;
      expiresAt: string | null;
    }>;
  } | null;
};

const dashboardState = {
  paths: {
    configPath: "/tmp/config.yaml",
    authDir: "/tmp/auth",
    backupRoot: "/tmp/backups",
    logsDir: "/tmp/logs",
    mainLogPath: "/tmp/logs/main.log",
    quotaSnapshotStatePath: "/tmp/quota.json",
    proxyUrl: "http://127.0.0.1:8317",
    proxyPort: 8317,
    inboundKeyConfigured: false,
  },
  config: {
    path: "/tmp/config.yaml",
    port: 8317,
    authDir: "/tmp/auth",
    routingStrategy: "priority",
    sessionAffinity: false,
    apiKeysConfigured: false,
    apiKeyCount: 0,
  },
  accounts: [],
  selectedAccount: null,
  models: [],
  logSummary: {
    latestSelection: null,
    latestCodexSelection: null,
    recentSelections: [],
    latestRequest: null,
    recentRequests: [],
  },
  errors: [],
  lastRefreshedAt: "2026-07-16T12:00:00.000Z",
};

function view(overrides: Partial<UsageView> = {}): UsageView {
  return {
    state: "usage-ready-no-resets",
    errorCode: null,
    message: "No earned usage limit resets available.",
    runtime: { status: "qualified", version: "codex-cli 0.144.4" },
    account: { email: "operator@example.com", plan: "pro" },
    observedAt: "2026-07-16T12:00:00.000Z",
    usage: {
      primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2027-01-15T08:00:00.000Z" },
      secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: "2027-01-22T08:00:00.000Z" },
    },
    resetCredits: { availableCount: 0, selectionMode: "none", credits: [] },
    ...overrides,
  };
}

async function mockApi(page: Page, initial: UsageView, stateStatus = 200, deferFirstCodex = false) {
  let usage = initial;
  let codexCallCount = 0;
  let releaseFirstCodex: (() => void) | null = null;
  const requests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname === "/api/bootstrap") {
      await route.fulfill({ json: { operatorToken: "browser-test-token" } });
      return;
    }
    if (pathname === "/api/state") {
      await route.fulfill({ status: stateStatus, json: stateStatus === 200 ? dashboardState : { error: "dashboard unavailable" } });
      return;
    }
    if (pathname === "/api/codex/account-usage") {
      if (deferFirstCodex && codexCallCount++ === 0) {
        await new Promise<void>((resolve) => {
          releaseFirstCodex = resolve;
        });
      }
      await route.fulfill({ json: usage });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected browser test request" } });
  });
  return {
    requests,
    setUsage(next: UsageView) {
      usage = next;
    },
    releaseFirstCodex() {
      releaseFirstCodex?.();
      releaseFirstCodex = null;
    },
  };
}

async function load(page: Page, initial: UsageView = view(), stateStatus = 200) {
  const api = await mockApi(page, initial, stateStatus);
  await page.goto("/");
  await expect(page.locator("#codex-app-account-content .codex-account-state")).toBeVisible();
  return api;
}

test("keeps permanent Codex panel separate from Proxy Accounts", async ({ page }) => {
  await load(page);

  await expect(page.getByRole("heading", { name: "Codex app account" })).toBeVisible();
  await expect(page.locator("#codex-app-account-section")).toContainText(
    "do not affect or select Proxy Accounts",
  );
  await expect(page.locator("#codex-app-account-section [aria-live]")).toHaveCount(1);
  await expect(page.locator("#codex-app-account-section .codex-account-state[aria-live]")).toHaveCount(0);
  await expect(page.locator("#codex-app-account-section .codex-state-message[aria-live]")).toHaveCount(1);
  await expect(page.locator("#codex-app-account-content").getByRole("button")).toHaveCount(0);
});

test("renders every stable read-only state with fixed text", async ({ page }) => {
  const states = [
    ["signed-out", "Sign in to Codex with ChatGPT, then refresh.", "codex_auth_required"],
    ["runtime-unavailable", "Codex runtime unavailable. Check the configured Codex path.", "codex_runtime_unavailable"],
    ["runtime-incompatible", "Installed Codex does not expose the required usage-reset methods.", "codex_runtime_incompatible"],
    ["identity-incomplete", "Codex did not provide an email and known plan. Redemption is unavailable.", "codex_identity_incomplete"],
    ["read-failed", "Couldn’t load Codex app usage.", "codex_read_failed"],
    ["usage-ready-no-resets", "No earned usage limit resets available.", null],
    ["usage-ready-resets-available", "1 earned usage limit reset is available.", null],
  ] as const;
  const api = await load(page);

  for (const [state, message, errorCode] of states) {
    api.setUsage(
      view({
        state,
        message,
        errorCode,
        resetCredits:
          state === "usage-ready-resets-available"
            ? { availableCount: 1, selectionMode: "generic", credits: [] }
            : state === "usage-ready-no-resets"
              ? { availableCount: 0, selectionMode: "none", credits: [] }
              : null,
      }),
    );
    await page.reload();
    const panel = page.locator(`#codex-app-account-content .codex-state-${state}`);
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(message);
  }
});

test("keeps credit context visible and offers generic provider selection without mutation", async ({ page }) => {
  await load(
    page,
    view({
      state: "usage-ready-resets-available",
      message: "2 earned usage limit resets are available.",
      resetCredits: {
        availableCount: 2,
        selectionMode: "generic",
        credits: [
          {
            id: null,
            availability: "malformed",
            title: "<img src=x onerror=alert(1)>",
            description: "Reset & continue",
            grantedAt: null,
            expiresAt: null,
          },
        ],
      },
    }),
  );

  const panel = page.locator("#codex-app-account-content");
  await expect(panel.getByRole("list", { name: "Usage limit reset details" })).toBeVisible();
  await expect(panel).toContainText("<img src=x onerror=alert(1)>");
  await expect(panel).toContainText("Reset & continue");
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel).toContainText("OpenAI will select the reset");
  await expect(panel).toContainText("Redemption remains disabled.");
  await expect(panel.getByRole("button")).toHaveCount(0);
});

test("manual retry calls only Codex account usage endpoint", async ({ page }) => {
  const api = await load(
    page,
    view({ state: "read-failed", errorCode: "codex_read_failed", message: "Couldn’t load Codex app usage.", resetCredits: null }),
  );
  const stateCallsBefore = api.requests.filter((path) => path === "/api/state").length;
  api.setUsage(view({ state: "usage-ready-no-resets" }));

  await page.getByRole("button", { name: "Refresh Codex usage" }).click();
  await expect(page.locator("#codex-app-account-content")).toContainText("No earned usage limit resets available.");

  expect(api.requests.filter((path) => path === "/api/codex/account-usage").length).toBeGreaterThanOrEqual(2);
  expect(api.requests.filter((path) => path === "/api/state").length).toBe(stateCallsBefore);
});

test("renders Codex result even when Proxy Account dashboard state fails", async ({ page }) => {
  await load(page, view({ state: "usage-ready-no-resets" }), 503);
  await expect(page.locator("#codex-app-account-content")).toContainText("No earned usage limit resets available.");
});

test("shows loading state while initial Codex read is pending", async ({ page }) => {
  const api = await mockApi(page, view(), 200, true);
  await page.goto("/");
  await expect(page.locator("#codex-app-account-content .codex-state-loading")).toBeVisible();
  api.releaseFirstCodex();
  await expect(page.locator("#codex-app-account-content")).toContainText("No earned usage limit resets available.");
});
