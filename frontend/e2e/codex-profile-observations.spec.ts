import { expect, test, type Page } from "@playwright/test";

import type { CodexProfileObservationListView } from "../../shared/codex-profile-observation-types";
import type { CodexProfileRefreshRunView } from "../../shared/codex-profile-refresh-types";
import { mockApi, view } from "./codex-app-account-fixture";

const primaryId = "profile_M8JcV6Qq0YxE2kT4uN7sP9aB";
const pausedId = "profile_N9JcV7Qq1YxE3kT5uN8sP0aC";

function profileView(): CodexProfileObservationListView {
  return {
    profiles: [
      {
        profileId: primaryId,
        label: "Primary",
        enabled: true,
        order: 0,
        status: "latest-known",
        observation: {
          account: { email: "operator@example.com", plan: "pro" },
          observedAt: "2026-07-19T04:00:00.000Z",
          usage: {
            primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2026-07-20T00:00:00.000Z" },
            secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: null },
          },
          resetCredits: { availableCount: 2 },
          runtimeVersion: "codex-cli 0.144.4",
          freshness: "latest-known",
        },
      },
      {
        profileId: pausedId,
        label: "Paused",
        enabled: false,
        order: 1,
        status: "disabled",
        observation: null,
      },
    ],
    summary: {
      total: 2,
      pending: 0,
      fresh: 0,
      latestKnown: 1,
      refreshNeeded: 0,
      stale: 0,
      reLoginRequired: 0,
      disabled: 1,
      identityChanged: 0,
      cleanupRequired: 0,
      neverObserved: 0,
      profilesWithResets: 1,
    },
  };
}

async function observationsApi(
  page: Page,
  options: {
    initial?: CodexProfileObservationListView;
    failRefresh?: "read" | "identity";
    refreshAllMode?: "completed" | "partial" | "running";
  } = {},
) {
  const redemption = await mockApi(page, view({
    state: "usage-ready-resets-available",
    message: "1 earned usage limit reset is available.",
    account: { email: "fresh@example.com", plan: "pro" },
    usage: {
      primary: { usedPercent: 81, durationMinutes: 300, resetsAt: "2026-07-21T08:00:00.000Z" },
      secondary: { usedPercent: 64, durationMinutes: 10_080, resetsAt: null },
    },
    resetCredits: {
        availableCount: 1,
        selectionMode: "detailed",
        credits: [{
          availability: "available",
        title: "Fresh early reset",
        description: "Fresh server-returned credit context.",
        grantedAt: null,
        expiresAt: "2026-07-22T08:00:00.000Z",
      }],
    },
  }));
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const current = structuredClone(options.initial ?? profileView());
  let refreshAll: CodexProfileRefreshRunView = {
    source: null,
    outcome: "idle",
    startedAt: null,
    finishedAt: null,
    total: 0,
    completed: 0,
    currentProfileId: null,
    profiles: [],
  };
  let refreshAllPolls = 0;
  await page.route("**/api/codex/login-profiles**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ method, path, body: request.postData() ? request.postDataJSON() : null });
    if (path === "/api/codex/login-profiles/refresh-all") {
      if (method === "POST") {
        refreshAll = {
          source: "manual",
          outcome: "running",
          startedAt: "2026-07-19T06:00:00.000Z",
          finishedAt: null,
          total: 2,
          completed: 0,
          currentProfileId: primaryId,
          profiles: [
            { profileId: primaryId, label: "Primary", status: "refreshing", attempts: 1 },
            { profileId: pausedId, label: "Paused", status: "pending", attempts: 0 },
          ],
        };
        await route.fulfill({ status: 202, json: refreshAll });
        return;
      }
      if (method === "GET") {
        refreshAllPolls += 1;
        if (refreshAll.outcome === "running" && refreshAllPolls > 1 && options.refreshAllMode !== "running") {
          const completed = options.refreshAllMode === "completed";
          refreshAll = {
            ...refreshAll,
            outcome: completed ? "completed" : "partial",
            finishedAt: "2026-07-19T06:00:03.000Z",
            completed: 2,
            currentProfileId: null,
            profiles: [
              { profileId: primaryId, label: "Primary", status: "refreshed", attempts: 1 },
              completed
                ? { profileId: pausedId, label: "Paused", status: "skipped", attempts: 0, reason: "disabled" }
                : { profileId: pausedId, label: "Paused", status: "failed", attempts: 2, reason: "read-failed" },
            ],
          };
        }
        await route.fulfill({ json: refreshAll });
        return;
      }
      if (method === "DELETE") {
        refreshAll = {
          ...refreshAll,
          outcome: "cancelled",
          finishedAt: "2026-07-19T06:00:01.000Z",
          completed: 1,
          currentProfileId: null,
          profiles: refreshAll.profiles.map((profile) => ({ ...profile, status: "cancelled", reason: "cancelled" })),
        };
        await route.fulfill({ json: refreshAll });
        return;
      }
    }
    if (method === "GET" && path === "/api/codex/login-profiles") {
      await route.fulfill({ json: current });
      return;
    }
      if (method === "POST" && path === `/api/codex/login-profiles/${primaryId}/refresh`) {
      if (options.failRefresh) {
        if (options.failRefresh === "identity") {
          current.profiles[0] = {
            ...current.profiles[0]!,
            enabled: false,
            status: "identity-changed",
            observation: { ...current.profiles[0]!.observation!, freshness: "identity-changed" },
          };
          current.summary.latestKnown = 0;
          current.summary.identityChanged = 1;
          current.summary.profilesWithResets = 0;
        }
        await route.fulfill({ status: 503, json: { error: "Couldn’t refresh this Codex Login Profile." } });
        return;
      }
      current.profiles[0] = {
        ...current.profiles[0]!,
        status: "fresh",
        observation: {
          ...current.profiles[0]!.observation!,
          observedAt: "2026-07-19T06:00:00.000Z",
          usage: {
            ...current.profiles[0]!.observation!.usage,
            primary: { ...current.profiles[0]!.observation!.usage.primary!, usedPercent: 30 },
          },
          freshness: "fresh",
        },
      };
      current.summary.latestKnown = 0;
      current.summary.fresh = 1;
        await route.fulfill({ json: current.profiles[0] });
        return;
      }
      if (method === "POST" && path === `/api/codex/login-profiles/${primaryId}/login-again`) {
        await route.fulfill({ json: { profileId: primaryId, status: "login-in-progress" } });
        return;
      }
      if (method === "POST" && path === `/api/codex/login-profiles/${primaryId}/delete`) {
        current.profiles = current.profiles.filter((profile) => profile.profileId !== primaryId);
        current.summary = {
          total: current.profiles.length,
          pending: 0,
          fresh: 0,
          latestKnown: 0,
          refreshNeeded: 0,
          stale: 0,
          reLoginRequired: 0,
          disabled: current.profiles.filter((profile) => !profile.enabled).length,
          identityChanged: 0,
          cleanupRequired: 0,
          neverObserved: current.profiles.filter((profile) => profile.observation === null && profile.enabled).length,
          profilesWithResets: 0,
        };
        await route.fulfill({ json: { profileId: primaryId, status: "deleted" } });
        return;
      }
    if (method === "PATCH") {
      const profileId = path.split("/").at(-1);
      const index = current.profiles.findIndex((profile) => profile.profileId === profileId);
      const profile = current.profiles[index];
      const body = request.postDataJSON() as { label?: string; enabled?: boolean };
      if (!profile) {
        await route.fulfill({ status: 404, json: { error: "profile not found" } });
        return;
      }
      current.profiles[index] = {
        ...profile,
        ...body,
        status: body.enabled === false
          ? "disabled"
          : body.enabled === true && profile.observation === null
            ? "never-observed"
            : profile.status,
      };
      await route.fulfill({ json: current.profiles[index] });
      return;
    }
    if (method === "PUT" && path === "/api/codex/login-profiles/order") {
      const body = request.postDataJSON() as { profileIds: string[] };
      current.profiles = body.profileIds.map((profileId, order) => ({
        ...current.profiles.find((profile) => profile.profileId === profileId)!,
        order,
      }));
      await route.fulfill({ json: current });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected profile observation request" } });
  });
  await page.goto("/");
    return { requests, redemption };
}

test("compares latest-known profiles and refreshes only the selected row", async ({ page }) => {
  const { requests } = await observationsApi(page);
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });

  await expect(region.getByText("2 profiles", { exact: false })).toBeVisible();
  await expect(region.getByText("1 with resets", { exact: false })).toBeVisible();
  await expect(region.getByText("0 fresh", { exact: false })).toBeVisible();
  await expect(region.getByText("0 pending", { exact: false })).toBeVisible();
  await expect(region.getByText("0 identity-changed", { exact: false })).toBeVisible();
  await expect(region.getByText("0 never-observed", { exact: false })).toBeVisible();
  await expect(region).not.toContainText("2 credits");
  await expect(region.getByRole("button", { name: "Review reset for Primary" })).toBeVisible();
  const table = region.getByRole("table", { name: "Reset Checker Profile evidence" });
  const primary = table.getByRole("row", { name: /Primary operator@example.com/i });
  await expect(primary).toContainText("Latest-known");
  await expect(primary).toContainText("25% used");
  await expect(primary).toContainText("Resets");
  await expect(primary).toContainText("2 available");
  await expect(table.getByRole("row", { name: /Paused/i })).toContainText("Disabled");

  await primary.getByRole("button", { name: "Refresh Primary" }).click();

  await expect(primary).toContainText("Fresh");
  await expect(primary).toContainText("30% used");
  expect(requests.at(-1)).toEqual({
    method: "POST",
    path: `/api/codex/login-profiles/${primaryId}/refresh`,
    body: {},
  });
});

test("prepares one selected profile and confirms only fresh server-returned context", async ({ page }) => {
  const { redemption } = await observationsApi(page);
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });
  const review = region.getByRole("button", { name: "Review reset for Primary" });

  await expect(review).toBeDisabled();
  await region.getByRole("checkbox", { name: /Primary uses one ChatGPT workspace/ }).check();
  await review.click();

  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(dialog).toContainText("Primary");
  await expect(dialog).toContainText("fresh@example.com · pro plan · 1 reset available");
  await expect(dialog).toContainText("Primary 81% used");
  await expect(dialog).toContainText("Fresh early reset");
  await expect(dialog).not.toContainText("25% used");
  expect(redemption.prepareBodies).toEqual([{
    profileId: primaryId,
    singleWorkspaceAttested: true,
  }]);
});

test("keeps other profile observations visible while selected profile recovery blocks fresh prepare", async ({ page }) => {
  const initial = profileView();
  initial.profiles[0] = {
    ...initial.profiles[0]!,
    activeRedemption: {
      status: "ambiguous",
      proposalId: "r".repeat(43),
      allowedAction: "retry-same",
      selectionMode: "specific",
      dispatchAt: "2026-07-19T05:00:00.000Z",
    },
  };
  const { redemption } = await observationsApi(page, { initial });
  const table = page.getByRole("table", { name: "Reset Checker Profile evidence" });
  const primary = table.getByRole("row", { name: /Primary operator@example.com/i });

  await expect(primary).toContainText("Reset redemption: ambiguous");
  await expect(page.getByRole("region", { name: "Reset Checker Profiles" }).getByRole("button", { name: "Review reset for Primary" })).toHaveCount(0);
  await expect(table.getByRole("row", { name: /Paused/i })).toBeVisible();
  expect(redemption.prepareBodies).toEqual([]);
});

test("saves labels, enables profiles, and persists registry order", async ({ page }) => {
  const { requests } = await observationsApi(page);
  const table = page.getByRole("table", { name: "Reset Checker Profile evidence" });
  const primary = table.getByRole("row", { name: /Primary operator@example.com/i });

  await primary.getByRole("textbox", { name: "Label for Primary" }).fill("Work");
  await table.getByRole("row", { name: /Work operator@example.com/i })
    .getByRole("button", { name: "Save label for Primary" }).click();
  await expect(table.getByRole("row", { name: /Work operator@example.com/i })).toBeVisible();

  const paused = table.getByRole("row", { name: /Paused/i });
  await paused.getByRole("button", { name: "Enable Paused" }).click();
  await expect(table.getByRole("row", { name: /Paused/i })).toContainText("Never-observed");
  await table.getByRole("row", { name: /Paused/i }).getByRole("button", { name: "Move Paused up" }).click();
  await expect(table.getByRole("row").nth(1).getByRole("textbox")).toHaveValue("Paused");

  expect(requests.slice(-3)).toEqual([
    { method: "PATCH", path: `/api/codex/login-profiles/${primaryId}`, body: { label: "Work" } },
    { method: "PATCH", path: `/api/codex/login-profiles/${pausedId}`, body: { enabled: true } },
    { method: "PUT", path: "/api/codex/login-profiles/order", body: { profileIds: [pausedId, primaryId] } },
  ]);
});

test("guides the operator when no profiles exist", async ({ page }) => {
  await observationsApi(page, {
    initial: {
      profiles: [],
      summary: {
        total: 0,
        pending: 0,
        fresh: 0,
          latestKnown: 0,
          refreshNeeded: 0,
          stale: 0,
          reLoginRequired: 0,
        disabled: 0,
        identityChanged: 0,
        cleanupRequired: 0,
        neverObserved: 0,
        profilesWithResets: 0,
      },
    },
  });
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });

  await expect(region.getByText("0 profiles", { exact: false })).toBeVisible();
  await expect(region.getByText("No Reset Checker Profiles yet. Add one to retain read-only usage evidence.")).toBeVisible();
});

test("keeps latest-known evidence when selected refresh fails", async ({ page }) => {
  await observationsApi(page, { failRefresh: "read" });
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });
  const primary = region.getByRole("row", { name: /Primary operator@example.com/i });

  await primary.getByRole("button", { name: "Refresh Primary" }).click();

  await expect(region.getByRole("alert")).toContainText("Couldn’t refresh this Codex Login Profile.");
  await expect(primary).toContainText("Latest-known");
  await expect(primary).toContainText("25% used");
  await expect(primary).toContainText("2 available");
});

  test("shows identity quarantine after a mismatched refresh without counting retained resets", async ({ page }) => {
  await observationsApi(page, { failRefresh: "identity" });
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });
  const primary = region.getByRole("row", { name: /Primary operator@example.com/i });

  await primary.getByRole("button", { name: "Refresh Primary" }).click();

  await expect(region.getByRole("alert")).toContainText("Couldn’t refresh this Codex Login Profile.");
  await expect(primary).toContainText("Identity-changed");
  await expect(region.getByText("0 with resets", { exact: false })).toBeVisible();
  });

  test("exposes explicit Log in again for an auth-quarantined profile", async ({ page }) => {
    const initial = profileView();
    initial.profiles[0] = {
      ...initial.profiles[0]!,
      enabled: false,
      status: "re-login-required",
      observation: { ...initial.profiles[0]!.observation!, freshness: "re-login-required" },
    };
    const { requests } = await observationsApi(page, { initial });
    const row = page.getByRole("table", { name: "Reset Checker Profile evidence" })
      .getByRole("row", { name: /Primary operator@example.com/i });

    await row.getByRole("button", { name: "Log in again for Primary" }).click();

    await expect(page.getByRole("status", { name: "Codex profile onboarding status" }))
      .toContainText("Log in again with the intended Codex app account");
    expect(requests).toContainEqual({
      method: "POST",
      path: `/api/codex/login-profiles/${primaryId}/login-again`,
      body: {},
    });
  });

  test("requires explicit confirmation before deleting one profile", async ({ page }) => {
    const { requests } = await observationsApi(page);
    page.once("dialog", async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("Primary");
      await dialog.accept();
    });
    const table = page.getByRole("table", { name: "Reset Checker Profile evidence" });
    await table.getByRole("row", { name: /Primary operator@example.com/i })
      .getByRole("button", { name: "Delete Primary" }).click();

    expect(requests).toContainEqual({
      method: "POST",
      path: `/api/codex/login-profiles/${primaryId}/delete`,
      body: { confirmed: true },
    });
    await expect(table.getByRole("row", { name: /Primary operator@example.com/i })).toHaveCount(0);
    expect(requests).toContainEqual({
      method: "POST",
      path: `/api/codex/login-profiles/${primaryId}/delete`,
      body: { confirmed: true },
    });
  });

test("announces refresh-all progress and an honest partial outcome", async ({ page }) => {
  const { requests } = await observationsApi(page);
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });

  await region.getByRole("button", { name: "Refresh all Reset Checker Profiles" }).click();

  const status = region.getByRole("status", { name: "Codex profile refresh status" });
  await expect(status).toContainText("Refreshing 0 of 2 · Primary");
  await expect(status).toContainText("Refresh all partially completed · 2 of 2 · 1 failed");
  await expect(region.getByRole("button", { name: "Cancel refresh all" })).toBeDisabled();
  expect(requests).toContainEqual({ method: "POST", path: "/api/codex/login-profiles/refresh-all", body: {} });
  expect(requests).toContainEqual({ method: "GET", path: "/api/codex/login-profiles/refresh-all", body: null });
});

test("cancels refresh-all accessibly", async ({ page }) => {
  const { requests } = await observationsApi(page, { refreshAllMode: "running" });
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });

  await region.getByRole("button", { name: "Refresh all Reset Checker Profiles" }).click();
  const cancel = region.getByRole("button", { name: "Cancel refresh all" });
  await expect(cancel).toBeEnabled();
  await cancel.click();

  await expect(region.getByRole("status", { name: "Codex profile refresh status" }))
    .toContainText("Refresh all cancelled · 1 of 2");
  expect(requests).toContainEqual({ method: "DELETE", path: "/api/codex/login-profiles/refresh-all", body: null });
});

test("announces a completed refresh-all outcome", async ({ page }) => {
  await observationsApi(page, { refreshAllMode: "completed" });
  const region = page.getByRole("region", { name: "Reset Checker Profiles" });

  await region.getByRole("button", { name: "Refresh all Reset Checker Profiles" }).click();

  await expect(region.getByRole("status", { name: "Codex profile refresh status" }))
    .toContainText("Refresh all completed · 2 of 2");
});
