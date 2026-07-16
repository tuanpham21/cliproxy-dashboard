import { expect, test } from "@playwright/test";
import { load, mockApi, view } from "./codex-app-account-fixture";

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
    ["runtime-incompatible", "Codex runtime or local state does not meet the required safety contract.", "codex_runtime_incompatible"],
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

test("shows unavailable Windows private state and removes reset controls", async ({ page }) => {
  await mockApi(page, view({
    state: "usage-ready-resets-available",
    resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
  }), 200, false, {
    initialActiveRedemption: {
      status: "unavailable",
      code: "redemption-private-state-unavailable",
      message: "Private reset redemption state is unavailable on this host.",
    },
  });
  await page.goto("/");

  const panel = page.locator("#codex-app-account-content");
  await expect(panel.getByRole("alert")).toContainText(
    "Private reset redemption state is unavailable on this host.",
  );
  await expect(panel.getByRole("button", { name: "Review reset" })).toHaveCount(0);
});

test("keeps credit context visible and offers generic proposal selection without consume", async ({ page }) => {
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
  await expect(panel).toContainText("<img src=x onerror=alert(1)>");
  await expect(panel).toContainText("Reset & continue");
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel).toContainText("OpenAI will select the reset");
  await expect(panel.getByRole("group", { name: "Choose a usage limit reset" })).toBeVisible();
  await expect(panel.getByRole("radio", { name: /Use a reset/ })).toBeChecked();
  await expect(panel.getByRole("button", { name: "Review reset" })).toBeDisabled();
  await expect(panel.getByText("I confirm this Codex app account uses one ChatGPT workspace", { exact: false })).toBeVisible();
});

test("opens accessible confirmation, cancels explicitly, and restores opener focus", async ({ page }) => {
    const api = await load(
      page,
      view({
        state: "usage-ready-resets-available",
        message: "1 earned usage limit reset is available.",
        resetCredits: {
          availableCount: 1,
          selectionMode: "detailed",
          credits: [{
            id: "credit-1",
            availability: "available",
            title: "Early reset",
            description: "Provider chooses eligible windows.",
            grantedAt: "2026-07-01T00:00:00.000Z",
            expiresAt: null,
          }],
        },
      }),
    );
    const panel = page.locator("#codex-app-account-content");
    const review = panel.getByRole("button", { name: "Review reset" });
    const attestation = panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ });
    await expect(panel.getByRole("radio", { name: /Early reset/ })).toBeChecked();
    await attestation.check();
    await expect(review).toBeEnabled();

    await review.click();
    const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
    const cancel = dialog.getByRole("button", { name: "Cancel" });
    await expect(dialog).toBeVisible();
    await expect(cancel).toBeFocused();
    await expect(dialog).toContainText("OpenAI decides which eligible usage limits reset.");
    await expect(dialog).toContainText("Confirmation expires in 2:00");
    await expect(dialog.getByRole("button", { name: "Redeem reset" })).toBeEnabled();
    expect(api.prepareBodies).toEqual([{ creditId: "credit-1", singleWorkspaceAttested: true }]);

    await cancel.click();
    await expect(dialog).toBeHidden();
    await expect(review).toBeFocused();
    await expect(attestation).not.toBeChecked();
    expect(api.requests).toContain(`/api/codex/reset-redemptions/proposals/${"p".repeat(43)}`);
    expect(api.requests.some((path) => path.endsWith("/consume"))).toBe(false);
  });

test("keeps stable dialog through panel refresh and awaits DELETE before Escape closes", async ({ page }) => {
    const initial = view({
      state: "usage-ready-resets-available",
      message: "1 earned usage limit reset is available.",
      resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
    });
    const api = await mockApi(page, initial, 200, false, { deferCancel: true });
    await page.goto("/");
    const panel = page.locator("#codex-app-account-content");
    await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
    await panel.getByRole("button", { name: "Review reset" }).click();
    const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
    await expect(dialog).toBeVisible();

    await page.evaluate(() => document.getElementById("refresh-codex-account-btn")?.click());
    await expect(page.getByRole("button", { name: "Refresh Codex usage" })).toBeEnabled();
    await expect(dialog).toBeVisible();

    await page.keyboard.press("Escape");
    await expect.poll(() => api.requests.filter((path) => path === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}`).length).toBe(1);
    await expect(dialog).toBeVisible();
    api.releaseCancel();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Refresh Codex usage" })).toBeFocused();
  });

test("redeems from confirmation without DELETE and announces terminal reconciliation", async ({ page }) => {
  const api = await load(
    page,
    view({
      state: "usage-ready-resets-available",
      message: "1 earned usage limit reset is available.",
      resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
    }),
  );
  const panel = page.locator("#codex-app-account-content");
  await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });

  await dialog.getByRole("button", { name: "Redeem reset" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#codex-redemption-page-status")).toHaveText("Usage limits reset. Checking current usage…");
  expect(api.requests).toContain(`/api/codex/reset-redemptions/proposals/${"p".repeat(43)}/consume`);
  expect(api.requests.some((path) => path === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}`)).toBe(false);
});

for (const [code, message] of [
  ["codex_account_changed", "Codex app account changed before redemption. Nothing was redeemed. Review the current account and try again."],
  ["codex_reset_availability_changed", "Reset availability changed before redemption. Nothing was redeemed. Refresh and review the available resets."],
  ["codex_session_changed", "Codex session changed before redemption. Nothing was redeemed. Refresh the Codex app account panel and try again."],
  ["codex_proposal_expired", "Confirmation expired. Account details and reset availability were refreshed. Review them and try again."],
] as const) {
  test(`shows exact safe pre-dispatch failure ${code}`, async ({ page }) => {
    const initial = view({
      state: "usage-ready-resets-available",
      message: "1 earned usage limit reset is available.",
      resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
    });
    const api = await mockApi(page, initial, 200, false, {
      consumeError: { status: 409, code, error: message },
    });
    await page.goto("/");
    const panel = page.locator("#codex-app-account-content");
    await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
    await panel.getByRole("button", { name: "Review reset" }).click();
    const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
    await dialog.getByRole("button", { name: "Redeem reset" }).click();

    await expect(dialog).toBeHidden();
    await expect(page.locator("#codex-redemption-page-status")).toHaveText(message);
    expect(api.requests.some((path) => path === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}`)).toBe(false);
  });
}

test("allows local close after the 20-second consume wait without sending DELETE", async ({ page }) => {
  await page.clock.install();
  const initial = view({
    state: "usage-ready-resets-available",
    message: "1 earned usage limit reset is available.",
    resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
  });
  const api = await mockApi(page, initial, 200, false, { deferConsume: true });
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
  await dialog.getByRole("button", { name: "Redeem reset" }).click();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
  await page.clock.fastForward(20_000);
  await expect(dialog.getByRole("button", { name: "Close" })).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(api.requests.some((path) => path === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}`)).toBe(false);
  api.releaseConsume();
  await expect(page.locator("#codex-redemption-page-status")).toHaveText("Usage limits reset. Checking current usage…");
});

test("keeps Close-only behavior after an early consume connection loss", async ({ page }) => {
  const proposalId = "p".repeat(43);
  const initial = view({
    state: "usage-ready-resets-available",
    message: "1 earned usage limit reset is available.",
    resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
  });
  const api = await mockApi(page, initial, 200, false, {
    abortConsume: true,
    pollFallbackState: {
      status: "processing",
      proposalId,
      allowedAction: "poll",
      selectionMode: "generic",
      phase: "dispatch-intent",
      dispatchAt: "2026-07-16T12:00:01.000Z",
    },
  });
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
  await dialog.getByRole("button", { name: "Redeem reset" }).click();

  await expect(dialog.getByRole("button", { name: "Close" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(api.requestLog).not.toContainEqual({
    method: "DELETE",
    path: `/api/codex/reset-redemptions/proposals/${proposalId}`,
  });
});

for (const [state, message, isError] of [
  [{
    status: "terminal",
    proposalId: "p".repeat(43),
    allowedAction: "none",
    selectionMode: "generic",
    outcome: "reset",
    reconciliation: "reconciled",
    message: "Usage limits reset. Checking current usage…",
    auditEventId: "a".repeat(43),
    createdAt: "2026-07-16T12:00:03.000Z",
    expiresAt: "2026-07-16T12:10:03.000Z",
  }, "Usage limits reset. Checking current usage…", false],
  [{
    status: "ambiguous",
    proposalId: "p".repeat(43),
    allowedAction: "none",
    selectionMode: "generic",
    dispatchAt: "2026-07-16T12:00:01.000Z",
  }, "Couldn’t confirm whether redemption completed. Retry uses the same attempt and cannot repeat a completed redemption.", true],
] as const) {
  test(`reload polling reports ${state.status} redemption instead of expiry`, async ({ page }) => {
    const processing = {
      status: "processing" as const,
      proposalId: "p".repeat(43),
      allowedAction: "poll" as const,
      selectionMode: "generic" as const,
      phase: "dispatched" as const,
      dispatchAt: "2026-07-16T12:00:01.000Z",
    };
    await mockApi(page, view(), 200, false, {
      initialActiveRedemption: processing,
      pollStates: [state],
    });
    await page.goto("/");

    const pageStatus = page.locator("#codex-redemption-page-status");
    await expect(pageStatus).toHaveText(message);
    await expect(pageStatus).toHaveAttribute("role", isError ? "alert" : "status");
  });
}

test("resumes polling from browser-safe proposal state after reload without persisting attestation", async ({ page }) => {
    const initial = view({
      state: "usage-ready-resets-available",
      message: "1 earned usage limit reset is available.",
      resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
    });
    const api = await mockApi(page, initial);
    await page.goto("/");
    const panel = page.locator("#codex-app-account-content");
    await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
    await panel.getByRole("button", { name: "Review reset" }).click();
    await expect(page.getByRole("dialog", { name: "Redeem usage limit reset?" })).toBeVisible();

    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    const restoredDialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
    await expect(restoredDialog).toBeVisible();
    await expect(restoredDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(page.locator("#codex-app-account-content").getByRole("checkbox", {
      name: /I confirm this Codex app account uses one ChatGPT workspace/,
    })).toHaveCount(0);
    await expect.poll(() => api.requests.filter((path) => path === `/api/codex/reset-redemptions/${"p".repeat(43)}`).length).toBeGreaterThan(0);
    await restoredDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(restoredDialog).toBeHidden();
  });

test("re-enables cancel for a second prepared proposal", async ({ page }) => {
  const initial = view({
    state: "usage-ready-resets-available",
    message: "1 earned usage limit reset is available.",
    resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
  });
  const api = await mockApi(page, initial);
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  const attestation = panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ });
  await attestation.check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();

  await attestation.check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(api.prepareBodies).toHaveLength(2);
});

test("uses authoritative server context instead of session storage display fields", async ({ page }) => {
  const initial = view({
    state: "usage-ready-resets-available",
    message: "1 earned usage limit reset is available.",
    resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
  });
  await mockApi(page, initial);
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  await page.evaluate(() => {
    sessionStorage.setItem("cliproxy-dashboard/codex-reset-redemption/proposal", JSON.stringify({
      proposalId: "p".repeat(43),
      account: { email: "attacker@example.com", plan: "enterprise" },
      availableCount: 999,
      selection: { mode: "generic" },
    }));
  });

  await page.reload();
  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
  await expect(dialog).toContainText("operator@example.com");
  await expect(dialog).not.toContainText("attacker@example.com");
  await expect(dialog).not.toContainText("999 resets available");
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("polls a minimal active proposal without exposing unchecked confirmation context", async ({ page }) => {
  const proposalId = "p".repeat(43);
  const api = await mockApi(
    page,
    view({
      state: "usage-ready-resets-available",
      message: "1 earned usage limit reset is available.",
      resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
    }),
    200,
    false,
    {
      initialActiveRedemption: {
        status: "prepared",
        proposalId,
        allowedAction: "cancel",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        selectionMode: "generic",
      },
    },
  );
  await page.goto("/");

  await expect(page.locator("#codex-redemption-page-status")).toHaveText(
    "Another reset confirmation is active. Return to its original dashboard tab or wait for expiry.",
  );
  await expect(page.getByRole("dialog", { name: "Redeem usage limit reset?" })).toBeHidden();
  await expect(page.locator("#codex-app-account-content").getByRole("button", { name: "Review reset" })).toHaveCount(0);
  await expect.poll(() => api.requests.filter((path) => path === `/api/codex/reset-redemptions/${proposalId}`).length)
    .toBeGreaterThan(0);
});

test("shows authorization failure for minimal proposal reconnect", async ({ page }) => {
  const proposalId = "p".repeat(43);
  const api = await mockApi(
    page,
    view({
      state: "usage-ready-resets-available",
      message: "1 earned usage limit reset is available.",
      resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
    }),
    200,
    false,
    {
      pollStatus: 403,
      initialActiveRedemption: {
        status: "prepared",
        proposalId,
        allowedAction: "cancel",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
        selectionMode: "generic",
      },
    },
  );
  await page.goto("/");

  await expect(page.locator("#codex-redemption-page-status")).toHaveText(
    "Dashboard authorization expired. Reload this local dashboard to continue.",
  );
  const polls = api.requests.filter((path) => path === `/api/codex/reset-redemptions/${proposalId}`).length;
  await page.waitForTimeout(1_200);
  expect(api.requests.filter((path) => path === `/api/codex/reset-redemptions/${proposalId}`).length).toBe(polls);
});

test("stops polling on authorization failure without cancelling server state", async ({ page }) => {
  const initial = view({
    state: "usage-ready-resets-available",
    message: "1 earned usage limit reset is available.",
    resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
  });
  const api = await mockApi(page, initial, 200, false, { pollStatus: 403, proposalTtlMs: 5_000 });
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
  await expect(dialog.getByRole("alert")).toHaveText(
    "Dashboard authorization expired. Reload this local dashboard to continue.",
  );
  const countdown = dialog.locator("#codex-redemption-countdown");
  const countdownBefore = await countdown.textContent();
  const polls = api.requests.filter((path) => path === `/api/codex/reset-redemptions/${"p".repeat(43)}`).length;
  await page.waitForTimeout(1_200);
  expect(api.requests.filter((path) => path === `/api/codex/reset-redemptions/${"p".repeat(43)}`).length).toBe(polls);
  await expect(countdown).not.toHaveText(countdownBefore ?? "");
  expect(api.requests.some((path) => path === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}`)).toBe(false);
});

test("does not announce already-missed countdown thresholds", async ({ page }) => {
  const initial = view({
    state: "usage-ready-resets-available",
    message: "1 earned usage limit reset is available.",
    resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
  });
  await mockApi(page, initial, 200, false, { proposalTtlMs: 20_000 });
  await page.goto("/");
  const panel = page.locator("#codex-app-account-content");
  await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
  await panel.getByRole("button", { name: "Review reset" }).click();
  const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
  await expect(dialog.locator("#codex-redemption-threshold-status")).toBeEmpty();
  await page.waitForTimeout(500);
  await expect(dialog.locator("#codex-redemption-threshold-status")).toBeEmpty();
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("uses server expiry state to close, refresh, clear attestation, and announce fixed copy", async ({ page }) => {
    const initial = view({
      state: "usage-ready-resets-available",
      message: "1 earned usage limit reset is available.",
      resetCredits: { availableCount: 1, selectionMode: "generic", credits: [] },
    });
    const api = await mockApi(page, initial, 200, false, { proposalTtlMs: 800 });
    await page.goto("/");
    const panel = page.locator("#codex-app-account-content");
    await panel.getByRole("checkbox", { name: /I confirm this Codex app account uses one ChatGPT workspace/ }).check();
    await panel.getByRole("button", { name: "Review reset" }).click();
    const dialog = page.getByRole("dialog", { name: "Redeem usage limit reset?" });
    await expect(dialog).toBeVisible();

    await expect(dialog).toBeHidden({ timeout: 5_000 });
    await expect(page.locator("#codex-redemption-page-status")).toHaveText(
      "Confirmation expired. Account details and reset availability were refreshed. Review them and try again.",
    );
    await expect(page.locator("#codex-app-account-content").getByRole("checkbox", {
      name: /I confirm this Codex app account uses one ChatGPT workspace/,
    })).not.toBeChecked();
    expect(api.requests.some((path) => path === `/api/codex/reset-redemptions/proposals/${"p".repeat(43)}`)).toBe(false);
    expect(api.requests).toContain(`/api/codex/reset-redemptions/${"p".repeat(43)}`);
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
