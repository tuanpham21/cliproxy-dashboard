import { expect, test, type Page } from "@playwright/test";

import type { CodexProfileObservationListView } from "../../shared/codex-profile-observation-types";
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
      disabled: 1,
      identityChanged: 0,
      neverObserved: 0,
      profilesWithResets: 1,
    },
  };
}

async function observationsApi(
  page: Page,
  options: { initial?: CodexProfileObservationListView; failRefresh?: "read" | "identity" } = {},
) {
  await mockApi(page, view());
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const current = structuredClone(options.initial ?? profileView());
  await page.route("**/api/codex/login-profiles**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    requests.push({ method, path, body: request.postData() ? request.postDataJSON() : null });
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
  return requests;
}

test("compares latest-known profiles and refreshes only the selected row", async ({ page }) => {
  const requests = await observationsApi(page);
  const region = page.getByRole("region", { name: "Codex Login Profiles" });

  await expect(region.getByText("2 profiles", { exact: false })).toBeVisible();
  await expect(region.getByText("1 with resets", { exact: false })).toBeVisible();
  await expect(region.getByText("0 fresh", { exact: false })).toBeVisible();
  await expect(region.getByText("0 pending", { exact: false })).toBeVisible();
  await expect(region.getByText("0 identity-changed", { exact: false })).toBeVisible();
  await expect(region.getByText("0 never-observed", { exact: false })).toBeVisible();
  await expect(region).not.toContainText("2 credits");
  await expect(region.getByRole("button", { name: /redeem|reset/i })).toHaveCount(0);
  const table = region.getByRole("table", { name: "Codex Login Profile evidence" });
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

test("saves labels, enables profiles, and persists registry order", async ({ page }) => {
  const requests = await observationsApi(page);
  const table = page.getByRole("table", { name: "Codex Login Profile evidence" });
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
        disabled: 0,
        identityChanged: 0,
        neverObserved: 0,
        profilesWithResets: 0,
      },
    },
  });
  const region = page.getByRole("region", { name: "Codex Login Profiles" });

  await expect(region.getByText("0 profiles", { exact: false })).toBeVisible();
  await expect(region.getByText("No Codex Login Profiles yet. Add one to retain read-only usage evidence.")).toBeVisible();
});

test("keeps latest-known evidence when selected refresh fails", async ({ page }) => {
  await observationsApi(page, { failRefresh: "read" });
  const region = page.getByRole("region", { name: "Codex Login Profiles" });
  const primary = region.getByRole("row", { name: /Primary operator@example.com/i });

  await primary.getByRole("button", { name: "Refresh Primary" }).click();

  await expect(region.getByRole("alert")).toContainText("Couldn’t refresh this Codex Login Profile.");
  await expect(primary).toContainText("Latest-known");
  await expect(primary).toContainText("25% used");
  await expect(primary).toContainText("2 available");
});

test("shows identity quarantine after a mismatched refresh without counting retained resets", async ({ page }) => {
  await observationsApi(page, { failRefresh: "identity" });
  const region = page.getByRole("region", { name: "Codex Login Profiles" });
  const primary = region.getByRole("row", { name: /Primary operator@example.com/i });

  await primary.getByRole("button", { name: "Refresh Primary" }).click();

  await expect(region.getByRole("alert")).toContainText("Couldn’t refresh this Codex Login Profile.");
  await expect(primary).toContainText("Identity-changed");
  await expect(region.getByText("0 with resets", { exact: false })).toBeVisible();
});
