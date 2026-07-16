import { expect, test } from "@playwright/test";

import { mockApi, view } from "./codex-app-account-fixture";

const proposalId = "p".repeat(43);
const ambiguous = {
  status: "ambiguous" as const,
  proposalId,
  allowedAction: "retry-same" as const,
  selectionMode: "generic" as const,
  dispatchAt: "2026-07-16T12:00:01.000Z",
};

test("shows only Retry same redemption and resolves the retained attempt", async ({ page }) => {
  const api = await mockApi(page, view(), 200, false, { initialActiveRedemption: ambiguous });
  await page.goto("/");

  const panel = page.locator("#codex-app-account-content");
  await expect(panel.getByRole("heading", { name: "Redemption recovery" })).toBeVisible();
  await expect(panel.getByText(proposalId)).toBeVisible();
  await expect(panel.getByText("OpenAI-selected reset")).toBeVisible();
  await expect(panel.getByText("Sent", { exact: true })).toBeVisible();
  const retry = panel.getByRole("button", { name: "Retry same redemption" });
  await expect(retry).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Review reset" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Cancel" })).toHaveCount(0);

  await retry.click();

  await expect(page.locator("#codex-redemption-page-status")).toHaveText("Usage limits reset. Checking current usage…");
  expect(api.requestLog).toContainEqual({
    method: "POST",
    path: `/api/codex/reset-redemptions/proposals/${proposalId}/consume`,
  });
  expect(api.requestLog).not.toContainEqual({
    method: "DELETE",
    path: `/api/codex/reset-redemptions/proposals/${proposalId}`,
  });
});

test("keeps retry available after exact account-digest mismatch", async ({ page }) => {
  const message = "Current Codex app account does not match this redemption attempt. Restore the account used for the attempt, then retry. New redemptions remain blocked.";
  await mockApi(page, view(), 200, false, {
    initialActiveRedemption: ambiguous,
    consumeError: { status: 409, code: "codex_recovery_account_mismatch", error: message },
  });
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  const retry = panel.getByRole("button", { name: "Retry same redemption" });

  await retry.click();

  await expect(page.locator("#codex-redemption-page-status")).toHaveText(message);
  await expect(page.locator("#codex-redemption-page-status")).toHaveAttribute("role", "alert");
  await expect(retry).toBeEnabled();
});

test("shows claimed retry as polling-only with no mutation action", async ({ page }) => {
  await mockApi(page, view(), 200, false, {
    initialActiveRedemption: {
      status: "processing",
      proposalId,
      allowedAction: "poll",
      selectionMode: "specific",
      phase: "retrying",
      dispatchAt: "2026-07-16T12:00:01.000Z",
    },
  });
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");

  await expect(panel.getByText("Retrying the same redemption. New redemptions remain blocked.")).toBeVisible();
  await expect(panel.getByText("Specific reset")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry same redemption" })).toHaveCount(0);
});

test("switches a busy retry response to polling-only UI", async ({ page }) => {
  const retrying = {
    status: "processing" as const,
    proposalId,
    allowedAction: "poll" as const,
    selectionMode: "generic" as const,
    phase: "retrying" as const,
    dispatchAt: "2026-07-16T12:00:01.000Z",
  };
  const api = await mockApi(page, view(), 200, false, {
    initialActiveRedemption: ambiguous,
    consumeResult: retrying,
    pollFallbackState: retrying,
  });
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  const accountReadsBefore = api.requests.filter((request) => request === "/api/codex/account-usage").length;

  await panel.getByRole("button", { name: "Retry same redemption" }).click();

  await expect(panel.getByText("Retrying the same redemption. New redemptions remain blocked.")).toBeVisible();
  await expect(panel.getByRole("button", { name: "Retry same redemption" })).toHaveCount(0);
  expect(api.requests.filter((request) => request === "/api/codex/account-usage")).toHaveLength(accountReadsBefore);
});

test("reconnect polls recovery state without Codex account reads", async ({ page }) => {
  const terminal = {
    status: "terminal" as const,
    proposalId,
    allowedAction: "none" as const,
    selectionMode: "generic" as const,
    outcome: "alreadyRedeemed" as const,
    reconciliation: "reconciled" as const,
    message: "Usage limit reset was already redeemed. Checking current usage…",
    auditEventId: "a".repeat(43),
    createdAt: "2026-07-16T12:03:00.000Z",
    expiresAt: "2026-07-16T12:13:00.000Z",
  };
  const api = await mockApi(page, view(), 200, false, {
    initialActiveRedemption: ambiguous,
    pollStates: [terminal],
    pollFallbackState: terminal,
  });

  await page.goto("/");

  await expect(page.locator("#codex-redemption-page-status")).toHaveText(terminal.message);
  expect(api.requests.filter((request) => request === "/api/codex/account-usage")).toHaveLength(0);
  expect(api.requestLog).toContainEqual({
    method: "GET",
    path: `/api/codex/reset-redemptions/${proposalId}`,
  });
});

test("fails closed without Codex reads when current recovery state is unavailable", async ({ page }) => {
  const api = await mockApi(page, view(), 200, false, { currentStatus: 500 });
  const currentResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === "/api/codex/reset-redemptions/current"
  ));

  await page.goto("/");
  await currentResponse;

  await expect(page.locator("#codex-app-account-content").getByRole("alert")).toHaveText(
    "Reset redemption recovery state is unavailable. Codex account reads are paused.",
  );
  expect(api.requests.filter((request) => request === "/api/codex/account-usage")).toHaveLength(0);
});
