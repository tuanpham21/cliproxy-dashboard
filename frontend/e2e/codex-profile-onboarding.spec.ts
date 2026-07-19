import { expect, test, type Page } from "@playwright/test";

import { mockApi, view } from "./codex-app-account-fixture";

const profileId = "profile_M8JcV6Qq0YxE2kT4uN7sP9aB";

function candidate(email = "operator@example.com", plan = "pro") {
  return {
    profileId,
    status: "awaiting-confirmation" as const,
    account: { email, plan },
    observedAt: "2026-07-19T04:00:00.000Z",
    usage: {
      primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2027-01-15T08:00:00.000Z" },
      secondary: null,
    },
    resetCredits: { availableCount: 2 },
  };
}

async function onboardingApi(page: Page) {
  await mockApi(page, view());
  let observed = candidate();
  let failObservation = false;
  let deferObservation = false;
  let releaseObservation: (() => void) | null = null;
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/api/codex/login-profiles**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    requests.push({ method, path: pathname, body });
    if (method === "GET" && pathname === "/api/codex/login-profiles") {
      await route.fulfill({ json: { profiles: [], summary: { total: 0, pending: 0, fresh: 0, latestKnown: 0, disabled: 0, identityChanged: 0, neverObserved: 0, profilesWithResets: 0 } } });
      return;
    }
    if (method === "POST" && pathname === "/api/codex/login-profiles") {
      await route.fulfill({ status: 201, json: { profileId, status: "login-in-progress" } });
      return;
    }
    if (method === "GET" && pathname.endsWith("/onboarding")) {
      if (deferObservation) {
        await new Promise<void>((resolve) => {
          releaseObservation = resolve;
        });
      }
      if (failObservation) {
        await route.fulfill({
          status: 503,
          json: { code: "read-failed", error: "Couldn’t check this Codex Login Profile." },
        });
      } else {
        await route.fulfill({ json: observed });
      }
      return;
    }
    if (method === "POST" && pathname.endsWith("/retry")) {
      await route.fulfill({ json: { profileId, status: "login-in-progress" } });
      return;
    }
    if (method === "POST" && pathname.endsWith("/confirm")) {
      await route.fulfill({ json: { ...observed, status: "confirmed" } });
      return;
    }
    if (method === "DELETE" && pathname === `/api/codex/login-profiles/${profileId}`) {
      await route.fulfill({ json: { profileId, status: "cancelled" } });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "unexpected onboarding request" } });
  });
  await page.goto("/");
  await expect(page.locator("#codex-app-account-content .codex-account-state")).toBeVisible();
  return {
    requests,
    setCandidate(email: string, plan = "pro") {
      observed = candidate(email, plan);
    },
    failObservation() {
      failObservation = true;
    },
    deferObservation() {
      deferObservation = true;
    },
    releaseObservation() {
      releaseObservation?.();
      releaseObservation = null;
    },
  };
}

test("adds a private Codex Login Profile and confirms the first read-only account result", async ({ page }) => {
  const api = await onboardingApi(page);

  await page.getByRole("button", { name: "Add Codex Login Profile" }).click();
  await expect(page.getByRole("status", { name: "Codex profile onboarding status" })).toContainText(
    "Finish the official browser login",
  );
  const check = page.getByRole("button", { name: "Check logged-in account" });
  await expect(check).toBeFocused();
  await check.click();

  const onboarding = page.getByRole("region", { name: "Codex Login Profiles" });
  await expect(onboarding.getByText("operator@example.com", { exact: true })).toBeVisible();
  await expect(onboarding.getByText("Pro", { exact: true })).toBeVisible();
  await expect(onboarding.getByText("2 available", { exact: true })).toBeVisible();
  const confirm = page.getByRole("button", { name: "Confirm Codex account" });
  const confirmation = page.getByRole("checkbox", { name: /intended Codex app account/i });
  await expect(confirmation).toBeFocused();
  await expect(confirm).toBeDisabled();
  await confirmation.check();
  await confirm.click();

  await expect(page.getByRole("status", { name: "Codex profile onboarding status" })).toContainText(
    "Codex Login Profile confirmed",
  );
  await expect(page.getByRole("button", { name: "Add Codex Login Profile" })).toBeFocused();
  const confirmationRequest = api.requests.find((entry) => entry.path.endsWith("/confirm"));
  expect(confirmationRequest?.body).toEqual({ confirmed: true, email: "operator@example.com", plan: "pro" });
  expect(JSON.stringify(api.requests)).not.toMatch(/codexStateRoot|codexSqliteRoot|\/private\//);
});

test("shows a wrong browser account and retries only that pending profile", async ({ page }) => {
  const api = await onboardingApi(page);
  api.setCandidate("wrong@example.com", "plus");
  await page.getByRole("button", { name: "Add Codex Login Profile" }).click();
  await page.getByRole("button", { name: "Check logged-in account" }).click();
  const onboarding = page.getByRole("region", { name: "Codex Login Profiles" });
  await expect(onboarding.getByText("wrong@example.com", { exact: true })).toBeVisible();

  api.setCandidate("operator@example.com", "pro");
  await page.getByRole("button", { name: "Retry browser login" }).click();
  await expect(page.getByRole("status", { name: "Codex profile onboarding status" })).toContainText(
    "Browser login restarted",
  );
  const check = page.getByRole("button", { name: "Check logged-in account" });
  await expect(check).toBeFocused();
  await check.click();
  await expect(onboarding.getByText("operator@example.com", { exact: true })).toBeVisible();
  expect(api.requests.filter((entry) => entry.path.endsWith("/retry"))).toEqual([
    { method: "POST", path: `/api/codex/login-profiles/${profileId}/retry`, body: {} },
  ]);
});

test("announces a fixed account-check failure and keeps retry and cancel available", async ({ page }) => {
  const api = await onboardingApi(page);
  api.failObservation();
  await page.getByRole("button", { name: "Add Codex Login Profile" }).click();
  await page.getByRole("button", { name: "Check logged-in account" }).click();

  await expect(page.getByRole("alert", { name: "Codex profile onboarding error" })).toHaveText(
    "Couldn’t check this Codex Login Profile.",
  );
  await expect(page.getByRole("button", { name: "Retry browser login" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Cancel Codex profile onboarding" })).toBeVisible();
});

test("cancels onboarding and reports pending private-root cleanup", async ({ page }) => {
  const api = await onboardingApi(page);
  api.deferObservation();
  await page.getByRole("button", { name: "Add Codex Login Profile" }).click();
  await page.getByRole("button", { name: "Check logged-in account" }).click();
  const cancel = page.getByRole("button", { name: "Cancel Codex profile onboarding" });
  await expect(cancel).toBeEnabled();
  await cancel.click();

  await expect(page.getByRole("status", { name: "Codex profile onboarding status" })).toHaveText(
    "Onboarding cancelled. Pending Codex Login Profile data was cleaned up.",
  );
  await expect(page.getByRole("button", { name: "Add Codex Login Profile" })).toBeFocused();
  api.releaseObservation();
  expect(api.requests).toContainEqual({
    method: "DELETE",
    path: `/api/codex/login-profiles/${profileId}`,
    body: null,
  });
});
