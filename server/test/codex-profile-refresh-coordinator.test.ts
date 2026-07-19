import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexAccountGatewayError } from "../codex-account-gateway.js";
import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { CodexProfileObservationService } from "../codex-profile-observation-service.js";
import { CodexProfileObservationStore } from "../codex-profile-observation-store.js";
import { CodexProfileRefreshCoordinator } from "../codex-profile-refresh-coordinator.js";
import type { CodexRuntimeQualifierLike } from "../codex-runtime-qualifier.js";
import { makeTempRoot } from "./helpers.js";

const profileIds = [
  "profile_R9nM4cX7vL6sP2rK5dB3tQ8w",
  "profile_S2nM5cX8vL7sP3rK6dB4tQ9w",
  "profile_T3nM6cX9vL8sP4rK7dB5tQ2w",
];

function qualifier(): CodexRuntimeQualifierLike {
  return {
    qualify: vi.fn(async (_codexBin, runtimeContext) => ({
      status: "qualified" as const,
      version: "codex-cli 0.145.0",
      identity: {
        canonicalPath: "/canonical/bin/codex",
        ...runtimeContext,
        version: "codex-cli 0.145.0",
        fileIdentity: `identity:${runtimeContext.codexStateRoot}`,
        schemaHash: "schema-hash-refresh-all",
      },
    })),
    matchesIdentity: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
}

describe("Codex Profile Refresh Coordinator", () => {
  it("refreshes profiles sequentially in operator order, retries one transient failure, and continues", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [...profileIds];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
    const profiles = await Promise.all([registry.create(), registry.create(), registry.create()]);
    for (const profile of profiles) await registry.confirm(profile.id);
    const profileByHome = new Map(profiles.map((profile) => [profile.runtimeContext.codexStateRoot, profile]));
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;
    const failedAttempts = new Map<string, number>();
    const consumeResetCredit = vi.fn();
    const service = new CodexProfileObservationService({
      registry,
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: qualifier(),
      startReadGateway: vi.fn(async ({ runtimeContext }) => {
        const profile = profileByHome.get(runtimeContext.codexStateRoot)!;
        starts.push(profile.id);
        active += 1;
        maxActive = Math.max(maxActive, active);
        return {
          readAccount: vi.fn(async () => ({
            account: { type: "chatgpt" as const, email: `${profile.order}@example.com`, plan: "pro" as const },
            providerRequiresOpenAiAuth: false,
          })),
          readRateLimits: vi.fn(async () => {
            if (profile.id === profiles[1]!.id) {
              failedAttempts.set(profile.id, (failedAttempts.get(profile.id) ?? 0) + 1);
              throw new CodexAccountGatewayError("transport-failed");
            }
            return {
              rateLimits: {
                limitId: "codex",
                limitName: "Codex",
                primary: { usedPercent: profile.order * 10, windowMinutes: 300, resetsAt: null },
                secondary: null,
                plan: "pro" as const,
              },
              rateLimitsByLimitId: null,
              resetCredits: { availableCount: profile.order, credits: null },
            };
          }),
          close: vi.fn(async () => { active -= 1; }),
          consumeResetCredit,
        };
      }),
    });
    const backoff = vi.fn(async () => {});
    const coordinator = new CodexProfileRefreshCoordinator({ observationService: service, backoff });

    const result = await coordinator.refreshAll("manual");

    expect(result).toMatchObject({
      source: "manual",
      outcome: "partial",
      total: 3,
      completed: 3,
      profiles: [
        { profileId: profiles[0]!.id, status: "refreshed", attempts: 1 },
        { profileId: profiles[1]!.id, status: "failed", attempts: 2, reason: "read-failed" },
        { profileId: profiles[2]!.id, status: "refreshed", attempts: 1 },
      ],
    });
    expect(starts).toEqual([
      profiles[0]!.id,
      profiles[1]!.id,
      profiles[1]!.id,
      profiles[2]!.id,
    ]);
    expect(maxActive).toBe(1);
    expect(failedAttempts.get(profiles[1]!.id)).toBe(2);
    expect(backoff).toHaveBeenCalledTimes(1);
    expect(consumeResetCredit).not.toHaveBeenCalled();
  });

  it("does not retry authentication failures, marks re-login required, and continues", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [...profileIds];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
    const first = await registry.create();
    const second = await registry.create();
    await registry.confirm(first.id);
    await registry.confirm(second.id);
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(first.id, null, {
      account: { email: "first@example.com", plan: "pro" },
      observedAt: "2026-07-19T04:00:00.000Z",
      usage: { primary: null, secondary: null },
      resetCredits: { availableCount: 1 },
      runtimeVersion: "codex-cli 0.144.4",
      freshness: "fresh",
    });
    const byHome = new Map([first, second].map((profile) => [profile.runtimeContext.codexStateRoot, profile]));
    const attempts = new Map<string, number>();
    const consumeResetCredit = vi.fn();
    const service = new CodexProfileObservationService({
      registry,
      observationStore: store,
      codexBin: "/trusted/bin/codex",
      qualifier: qualifier(),
      startReadGateway: vi.fn(async ({ runtimeContext }) => {
        const profile = byHome.get(runtimeContext.codexStateRoot)!;
        attempts.set(profile.id, (attempts.get(profile.id) ?? 0) + 1);
        return {
          readAccount: vi.fn(async () => {
            if (profile.id === first.id) throw new CodexAccountGatewayError("authentication-required");
            return {
              account: { type: "chatgpt" as const, email: "second@example.com", plan: "plus" as const },
              providerRequiresOpenAiAuth: false,
            };
          }),
          readRateLimits: vi.fn(async () => ({
            rateLimits: { limitId: "codex", limitName: "Codex", primary: null, secondary: null, plan: "plus" as const },
            rateLimitsByLimitId: null,
            resetCredits: { availableCount: 0, credits: null },
          })),
          close: vi.fn(async () => {}),
          consumeResetCredit,
        };
      }),
    });
    const backoff = vi.fn(async () => {});
    const coordinator = new CodexProfileRefreshCoordinator({ observationService: service, backoff });

    const result = await coordinator.refreshAll("manual");

    expect(result).toMatchObject({
      outcome: "partial",
      profiles: [
        { profileId: first.id, status: "failed", attempts: 1, reason: "re-login-required" },
        { profileId: second.id, status: "refreshed", attempts: 1 },
      ],
    });
    expect(attempts.get(first.id)).toBe(1);
    expect(attempts.get(second.id)).toBe(1);
    expect(backoff).not.toHaveBeenCalled();
    expect(consumeResetCredit).not.toHaveBeenCalled();
    await expect(service.list()).resolves.toMatchObject({
      profiles: [
        { profileId: first.id, enabled: false, status: "re-login-required", observation: { freshness: "re-login-required" } },
        { profileId: second.id, status: "fresh" },
      ],
    });
    await expect(service.updateMetadata(first.id, { enabled: true })).rejects.toMatchObject({
      code: "profile-not-refreshable",
    });
  });

  it("persists re-login-required before any observation and skips it after restart", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileIds[0]! });
    const profile = await registry.create();
    await registry.confirm(profile.id);
    const consumeResetCredit = vi.fn();
    const startReadGateway = vi.fn(async () => ({
      readAccount: vi.fn(async () => { throw new CodexAccountGatewayError("authentication-required"); }),
      readRateLimits: vi.fn(),
      close: vi.fn(async () => {}),
      consumeResetCredit,
    }));
    const service = new CodexProfileObservationService({
      registry,
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: qualifier(),
      startReadGateway,
    });
    const coordinator = new CodexProfileRefreshCoordinator({ observationService: service, backoff: vi.fn() });

    await expect(coordinator.refreshAll("manual")).resolves.toMatchObject({
      outcome: "partial",
      profiles: [{ profileId: profile.id, status: "failed", attempts: 1, reason: "re-login-required" }],
    });

    const restartedGateway = vi.fn(async () => { throw new Error("must skip re-login-required profile"); });
    const restartedService = new CodexProfileObservationService({
      registry: new CodexLoginProfileRegistry({ managerRoot }),
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: qualifier(),
      startReadGateway: restartedGateway,
    });
    await expect(restartedService.list()).resolves.toMatchObject({
      profiles: [{ profileId: profile.id, enabled: false, status: "re-login-required", observation: null }],
      summary: { reLoginRequired: 1 },
    });
    await expect(new CodexProfileRefreshCoordinator({ observationService: restartedService }).refreshAll("scheduled"))
      .resolves.toMatchObject({
        outcome: "completed",
        profiles: [{ profileId: profile.id, status: "skipped", attempts: 0, reason: "re-login-required" }],
      });
    expect(startReadGateway).toHaveBeenCalledTimes(1);
    expect(restartedGateway).not.toHaveBeenCalled();
    expect(consumeResetCredit).not.toHaveBeenCalled();
  });

  it("skips disabled and re-login-required profiles without opening read sessions", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [...profileIds];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
    const enabled = await registry.create();
    const disabled = await registry.create();
    const loginRequired = await registry.create();
    for (const profile of [enabled, disabled, loginRequired]) await registry.confirm(profile.id);
    await registry.updateMetadata(disabled.id, { enabled: false });
    await registry.updateMetadata(loginRequired.id, { enabled: false });
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(loginRequired.id, null, {
      account: { email: "login-again@example.com", plan: "pro" },
      observedAt: "2026-07-19T04:00:00.000Z",
      usage: { primary: null, secondary: null },
      resetCredits: { availableCount: 1 },
      runtimeVersion: "codex-cli 0.144.4",
      freshness: "re-login-required",
    });
    const consumeResetCredit = vi.fn();
    const startReadGateway = vi.fn(async () => ({
      readAccount: vi.fn(async () => ({
        account: { type: "chatgpt" as const, email: "enabled@example.com", plan: "pro" as const },
        providerRequiresOpenAiAuth: false,
      })),
      readRateLimits: vi.fn(async () => ({
        rateLimits: { limitId: "codex", limitName: "Codex", primary: null, secondary: null, plan: "pro" as const },
        rateLimitsByLimitId: null,
        resetCredits: { availableCount: 0, credits: null },
      })),
      close: vi.fn(async () => {}),
      consumeResetCredit,
    }));
    const service = new CodexProfileObservationService({
      registry,
      observationStore: store,
      codexBin: "/trusted/bin/codex",
      qualifier: qualifier(),
      startReadGateway,
    });
    const coordinator = new CodexProfileRefreshCoordinator({ observationService: service });

    const result = await coordinator.refreshAll("manual");

    expect(result).toMatchObject({
      outcome: "completed",
      completed: 3,
      profiles: [
        { profileId: enabled.id, status: "refreshed", attempts: 1 },
        { profileId: disabled.id, status: "skipped", attempts: 0, reason: "disabled" },
        { profileId: loginRequired.id, status: "skipped", attempts: 0, reason: "re-login-required" },
      ],
    });
    expect(startReadGateway).toHaveBeenCalledTimes(1);
    expect(consumeResetCredit).not.toHaveBeenCalled();
  });

  it("cancels the current read session and starts no later profile", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [...profileIds];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
    const profiles = await Promise.all([registry.create(), registry.create(), registry.create()]);
    for (const profile of profiles) await registry.confirm(profile.id);
    let rejectRead!: (error: Error) => void;
    const readStarted = vi.fn();
    const close = vi.fn(async () => {
      rejectRead(new CodexAccountGatewayError("transport-failed"));
    });
    const consumeResetCredit = vi.fn();
    const startReadGateway = vi.fn(async () => ({
      readAccount: vi.fn(async () => ({
        account: { type: "chatgpt" as const, email: "current@example.com", plan: "pro" as const },
        providerRequiresOpenAiAuth: false,
      })),
      readRateLimits: vi.fn(async () => await new Promise<never>((_resolve, reject) => {
        rejectRead = reject;
        readStarted();
      })),
      close,
      consumeResetCredit,
    }));
    const service = new CodexProfileObservationService({
      registry,
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: qualifier(),
      startReadGateway,
    });
    const backoff = vi.fn(async () => {});
    const coordinator = new CodexProfileRefreshCoordinator({ observationService: service, backoff });

    const run = coordinator.refreshAll("manual");
    await vi.waitFor(() => expect(readStarted).toHaveBeenCalledTimes(1));
    const cancelled = await coordinator.cancel();

    await expect(run).resolves.toEqual(cancelled);
    expect(cancelled).toMatchObject({
      outcome: "cancelled",
      completed: 1,
      currentProfileId: null,
      profiles: [
        { profileId: profiles[0]!.id, status: "cancelled", attempts: 1, reason: "cancelled" },
        { profileId: profiles[1]!.id, status: "cancelled", attempts: 0, reason: "cancelled" },
        { profileId: profiles[2]!.id, status: "cancelled", attempts: 0, reason: "cancelled" },
      ],
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(startReadGateway).toHaveBeenCalledTimes(1);
    expect(backoff).not.toHaveBeenCalled();
    expect(consumeResetCredit).not.toHaveBeenCalled();
  });

  it("runs once at startup and schedules read-only refresh-all every 15 minutes", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileIds[0]! });
    const profile = await registry.create();
    await registry.confirm(profile.id);
    const consumeResetCredit = vi.fn();
    const startReadGateway = vi.fn(async () => ({
      readAccount: vi.fn(async () => ({
        account: { type: "chatgpt" as const, email: "scheduled@example.com", plan: "pro" as const },
        providerRequiresOpenAiAuth: false,
      })),
      readRateLimits: vi.fn(async () => ({
        rateLimits: { limitId: "codex", limitName: "Codex", primary: null, secondary: null, plan: "pro" as const },
        rateLimitsByLimitId: null,
        resetCredits: { availableCount: 0, credits: null },
      })),
      close: vi.fn(async () => {}),
      consumeResetCredit,
    }));
    const service = new CodexProfileObservationService({
      registry,
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: qualifier(),
      startReadGateway,
    });
    let scheduled!: () => Promise<unknown>;
    const schedule = vi.fn((task: () => Promise<unknown>, intervalMs: number) => {
      scheduled = task;
      expect(intervalMs).toBe(15 * 60 * 1_000);
      return { timer: "refresh-all" };
    });
    const clearSchedule = vi.fn();
    const coordinator = new CodexProfileRefreshCoordinator({
      observationService: service,
      schedule,
      clearSchedule,
    });

    await expect(coordinator.start()).resolves.toMatchObject({ source: "startup", outcome: "completed" });
    await expect(scheduled()).resolves.toMatchObject({ source: "scheduled", outcome: "completed" });
    await coordinator.close();

    expect(schedule).toHaveBeenCalledTimes(1);
    expect(startReadGateway).toHaveBeenCalledTimes(2);
    expect(clearSchedule).toHaveBeenCalledWith({ timer: "refresh-all" });
    expect(consumeResetCredit).not.toHaveBeenCalled();
  });
});
