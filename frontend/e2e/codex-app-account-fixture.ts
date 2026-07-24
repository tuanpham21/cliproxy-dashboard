import { expect, type Page } from "@playwright/test";
import type {
  CodexRedemptionCurrentView,
  CodexRedemptionProposalView,
} from "../../shared/codex-account-types";

export const TEST_CODEX_PROFILE_ID = `profile_${"t".repeat(32)}`;

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
    pollStates?: CodexRedemptionCurrentView[];
    pollFallbackState?: CodexRedemptionCurrentView;
      deferConsume?: boolean;
      abortConsume?: boolean;
      consumeError?: { status: number; code: string; error: string };
      consumeResult?: CodexRedemptionCurrentView;
      currentStatus?: number;
  } = {},
) {
  let usage = initial;
    let codexCallCount = 0;
    let releaseFirstCodex: (() => void) | null = null;
    let firstCodexReleaseRequested = false;
  let releaseCancel: (() => void) | null = null;
  let releaseConsume: (() => void) | null = null;
  let activeProposal: CodexRedemptionProposalView | null = null;
  let activeRedemption = redemptionOptions.initialActiveRedemption;
  const pollStates = [...(redemptionOptions.pollStates ?? [])];
  const requests: string[] = [];
  const requestLog: Array<{ method: string; path: string }> = [];
  const prepareBodies: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    requests.push(pathname);
    requestLog.push({ method: route.request().method(), path: pathname });
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
      if (pathname === "/api/codex/login-profiles" && route.request().method() === "GET") {
        const observation = usage.account && usage.usage ? {
          account: { email: usage.account.email ?? "operator@example.com", plan: usage.account.plan ?? "unknown" },
          observedAt: usage.observedAt ?? "2026-07-16T12:00:00.000Z",
          usage: usage.usage,
          resetCredits: { availableCount: usage.resetCredits?.availableCount ?? null },
          runtimeVersion: usage.runtime.version ?? "codex-cli 0.144.4",
          freshness: "fresh" as const,
        } : null;
        const profilesWithResets = (observation?.resetCredits.availableCount ?? 0) > 0 ? 1 : 0;
        await route.fulfill({ json: {
          profiles: [{
            profileId: TEST_CODEX_PROFILE_ID,
            label: "Primary",
            enabled: true,
            order: 0,
            status: observation ? "fresh" : "never-observed",
            observation,
            activeRedemption: activeProposal ?? activeRedemption ?? { status: "not-found" },
          }],
          summary: { total: 1, pending: 0, fresh: observation ? 1 : 0, latestKnown: 0, refreshNeeded: 0, stale: 0, reLoginRequired: 0, disabled: 0, identityChanged: 0, cleanupRequired: 0, neverObserved: observation ? 0 : 1, profilesWithResets },
        } });
        return;
      }
      if (pathname === "/api/codex/login-profiles/refresh-all" && route.request().method() === "GET") {
        await route.fulfill({ json: {
          source: null,
          outcome: "idle",
          startedAt: null,
          finishedAt: null,
          total: 0,
          completed: 0,
          currentProfileId: null,
          profiles: [],
        } });
        return;
      }
    if (pathname === "/api/codex/account-usage") {
        if (deferFirstCodex && codexCallCount++ === 0) {
          await new Promise<void>((resolve) => {
            if (firstCodexReleaseRequested) {
              resolve();
              return;
            }
            releaseFirstCodex = resolve;
          });
      }
      await route.fulfill({
        json: {
          ...usage,
          activeRedemption: activeProposal ?? activeRedemption ?? { status: "not-found" },
        },
      });
      return;
    }
      if (pathname === "/api/codex/reset-redemptions/current") {
        if (redemptionOptions.currentStatus && redemptionOptions.currentStatus !== 200) {
          await route.fulfill({
            status: redemptionOptions.currentStatus,
            json: { code: "recovery-state-unavailable", error: "recovery state unavailable" },
          });
          return;
        }
        await route.fulfill({ json: activeProposal ?? activeRedemption ?? { status: "not-found" } });
      return;
    }
    if (pathname === "/api/codex/reset-redemptions/proposals" && route.request().method() === "POST") {
          const body = route.request().postDataJSON() as { profileId?: string; singleWorkspaceAttested?: boolean };
        prepareBodies.push(body);
        const createdAt = new Date();
        const expiresAt = new Date(createdAt.getTime() + (redemptionOptions.proposalTtlMs ?? 120_000));
          const selected = usage.resetCredits?.credits
            .filter((credit) => credit.availability === "available")
            .sort((left, right) => {
              const leftExpiry = left.expiresAt ? Date.parse(left.expiresAt) : Number.POSITIVE_INFINITY;
              const rightExpiry = right.expiresAt ? Date.parse(right.expiresAt) : Number.POSITIVE_INFINITY;
              return leftExpiry - rightExpiry;
            })[0];
        const selection = selected
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
          ...(body.profileId ? { profile: { profileId: body.profileId, label: "Primary" } } : {}),
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
      const state = activeProposal
        ? {
            status: "prepared" as const,
            proposalId: activeProposal.proposalId,
            allowedAction: "cancel" as const,
            createdAt: activeProposal.createdAt,
            expiresAt: activeProposal.expiresAt,
            selectionMode: activeProposal.selection.mode,
          }
        : pollStates.shift() ?? redemptionOptions.pollFallbackState ?? activeRedemption ?? { status: "not-found" as const };
      if (!activeProposal) activeRedemption = state;
      await route.fulfill({ json: state });
      return;
    }
    if (pathname === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}/consume` && route.request().method() === "POST") {
      if (redemptionOptions.deferConsume) {
        await new Promise<void>((resolve) => {
          releaseConsume = resolve;
        });
      }
      activeProposal = null;
      if (redemptionOptions.abortConsume) {
        await route.abort("connectionfailed");
        return;
      }
        if (redemptionOptions.consumeError) {
          await route.fulfill({ status: redemptionOptions.consumeError.status, json: redemptionOptions.consumeError });
          return;
        }
        if (redemptionOptions.consumeResult) {
          activeRedemption = redemptionOptions.consumeResult;
          await route.fulfill({ json: activeRedemption });
          return;
        }
        const createdAt = new Date().toISOString();
      activeRedemption = {
        status: "terminal",
        proposalId: "p".repeat(43),
        allowedAction: "none",
        selectionMode: "generic",
        outcome: "reset",
        reconciliation: "reconciled",
        message: "Usage limits reset. Checking current usage…",
        auditEventId: "a".repeat(43),
        createdAt,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
      await route.fulfill({ json: activeRedemption });
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
    requestLog,
    prepareBodies,
    setUsage(next: UsageView) {
      usage = next;
    },
      releaseFirstCodex() {
        if (releaseFirstCodex) releaseFirstCodex();
        else firstCodexReleaseRequested = true;
        releaseFirstCodex = null;
    },
    releaseCancel() {
      releaseCancel?.();
      releaseCancel = null;
    },
    releaseConsume() {
      releaseConsume?.();
      releaseConsume = null;
    },
  };
}

export async function load(page: Page, initial: UsageView = view(), stateStatus = 200) {
  const api = await mockApi(page, initial, stateStatus);
  await page.goto("/");
  await expect(page.locator("#codex-app-account-content .codex-account-state")).toBeVisible();
  return api;
}
