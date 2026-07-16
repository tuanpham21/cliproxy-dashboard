import { expect, type Page } from "@playwright/test";
import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
} from "../../shared/codex-account-types";

export type UsageView = {
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

export function view(overrides: Partial<UsageView> = {}): UsageView {
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

export async function mockApi(
  page: Page,
  initial: UsageView,
  stateStatus = 200,
  deferFirstCodex = false,
  redemptionOptions: {
    deferCancel?: boolean;
    pollStatus?: number;
    proposalTtlMs?: number;
    initialActiveRedemption?: CodexRedemptionCurrentView;
  } = {},
) {
  let usage = initial;
  let codexCallCount = 0;
  let releaseFirstCodex: (() => void) | null = null;
  let releaseCancel: (() => void) | null = null;
  let activeProposal: CodexRedemptionProposalView | null = null;
  const requests: string[] = [];
  const prepareBodies: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    if (pathname === "/api/bootstrap") {
      await route.fulfill({ json: { operatorToken: "browser-test-token" } });
      return;
    }
    if (pathname === "/api/state") {
      await route.fulfill({
        status: stateStatus,
        json: stateStatus === 200 ? dashboardState : { error: "dashboard unavailable" },
      });
      return;
    }
    if (pathname === "/api/codex/account-usage") {
      if (deferFirstCodex && codexCallCount++ === 0) {
        await new Promise<void>((resolve) => {
          releaseFirstCodex = resolve;
        });
      }
      await route.fulfill({
        json: {
          ...usage,
          activeRedemption: activeProposal ?? redemptionOptions.initialActiveRedemption ?? { status: "not-found" },
        },
      });
      return;
    }
    if (pathname === "/api/codex/reset-redemptions/proposals" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { creditId?: string; singleWorkspaceAttested?: boolean };
      prepareBodies.push(body);
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + (redemptionOptions.proposalTtlMs ?? 120_000));
      const selected = usage.resetCredits?.credits.find((credit) => credit.id === body.creditId);
      const selection = body.creditId
        ? {
            mode: "specific" as const,
            title: selected?.title ?? "Usage limit reset",
            description: selected?.description ?? null,
            expiresAt: selected?.expiresAt ?? null,
          }
        : { mode: "generic" as const };
      activeProposal = {
        status: "prepared",
        proposalId: "p".repeat(43),
        allowedAction: "cancel",
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        account: usage.account as { email: string; plan: string },
        usage: usage.usage ?? { primary: null, secondary: null },
        availableCount: usage.resetCredits?.availableCount ?? 0,
        selection,
      };
      await route.fulfill({ status: 201, json: activeProposal });
      return;
    }
    if (pathname === `/api/codex/reset-redemptions/${"p".repeat(43)}` && route.request().method() === "GET") {
      if (redemptionOptions.pollStatus) {
        await route.fulfill({
          status: redemptionOptions.pollStatus,
          json: { code: "authorization-failed", error: "authorization failed" },
        });
        return;
      }
      if (activeProposal && Date.now() >= Date.parse(activeProposal.expiresAt)) activeProposal = null;
      await route.fulfill({
        json: activeProposal
          ? {
              status: "prepared",
              proposalId: activeProposal.proposalId,
              allowedAction: "cancel",
              createdAt: activeProposal.createdAt,
              expiresAt: activeProposal.expiresAt,
              selectionMode: activeProposal.selection.mode,
            }
          : redemptionOptions.initialActiveRedemption ?? { status: "not-found" },
      });
      return;
    }
    if (pathname === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}` && route.request().method() === "DELETE") {
      if (redemptionOptions.deferCancel) {
        await new Promise<void>((resolve) => {
          releaseCancel = resolve;
        });
      }
      activeProposal = null;
      await route.fulfill({ json: { status: "cancelled", proposalId: "p".repeat(43) } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected browser test request" } });
  });
  return {
    requests,
    prepareBodies,
    setUsage(next: UsageView) {
      usage = next;
    },
    releaseFirstCodex() {
      releaseFirstCodex?.();
      releaseFirstCodex = null;
    },
    releaseCancel() {
      releaseCancel?.();
      releaseCancel = null;
    },
  };
}

export async function load(page: Page, initial: UsageView = view(), stateStatus = 200) {
  const api = await mockApi(page, initial, stateStatus);
  await page.goto("/");
  await expect(page.locator("#codex-app-account-content .codex-account-state")).toBeVisible();
  return api;
}
