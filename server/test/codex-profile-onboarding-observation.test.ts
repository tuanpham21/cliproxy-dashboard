import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { CodexProfileObservationStore } from "../codex-profile-observation-store.js";
import { CodexProfileOnboardingService } from "../codex-profile-onboarding-service.js";
import type { CodexRuntimeQualifierLike } from "../codex-runtime-qualifier.js";
import { makeTempRoot } from "./helpers.js";

describe("Codex Login Profile confirmation observation", () => {
  it("persists the confirmed sanitized observation before enabling the profile", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_E8nM3cX6vL5sP9rK4dB2tH7w";
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const observationStore = new CodexProfileObservationStore({ managerRoot });
    const runtimeIdentity = {
      canonicalPath: "/canonical/bin/codex",
      codexStateRoot: "/unused-before-create",
      codexSqliteRoot: "/unused-before-create",
      version: "codex-cli 0.144.4",
      fileIdentity: "1:2:3:4",
      schemaHash: "schema-hash",
    };
    const qualifier: CodexRuntimeQualifierLike = {
      qualify: vi.fn(async (_codexBin, runtimeContext) => ({
        status: "qualified" as const,
        version: runtimeIdentity.version,
        identity: { ...runtimeIdentity, ...runtimeContext },
      })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    const loginRunner = {
      start: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    };
    const gateway = {
      readAccount: vi.fn(async () => ({
        account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
        providerRequiresOpenAiAuth: false,
      })),
      readRateLimits: vi.fn(async () => ({
        rateLimits: {
          limitId: "codex",
          limitName: "Codex",
          primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 60, windowMinutes: 10_080, resetsAt: null },
          plan: "pro" as const,
        },
        rateLimitsByLimitId: null,
        resetCredits: { availableCount: 2, credits: null },
      })),
      close: vi.fn(async () => {}),
    };
    const service = new CodexProfileOnboardingService({
      registry,
      observationStore,
      loginRunner,
      codexBin: "/trusted/bin/codex",
      qualifier,
      startReadGateway: vi.fn(async () => gateway),
      now: () => new Date("2026-07-19T04:00:00.000Z"),
    });

    await service.create();
    const candidate = await service.observe(profileId);
    await service.confirm(profileId, {
      confirmed: true,
      email: candidate.account.email,
      plan: candidate.account.plan,
    });

    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(profileId)).resolves.toMatchObject({
      status: "confirmed",
      enabled: true,
    });
    await expect(new CodexProfileObservationStore({ managerRoot }).get(profileId)).resolves.toMatchObject({
      generation: 1,
      snapshot: {
        account: { email: "operator@example.com", plan: "pro" },
        observedAt: "2026-07-19T04:00:00.000Z",
        usage: {
          primary: { usedPercent: 25, durationMinutes: 300 },
          secondary: { usedPercent: 60, durationMinutes: 10_080 },
        },
        resetCredits: { availableCount: 2 },
        runtimeVersion: "codex-cli 0.144.4",
        freshness: "latest-known",
      },
    });
  });

  it("serializes confirmation with cancellation so profile state and observation cannot diverge", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_R8nM3cX6vL5sP9rK4dB2tH7w";
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const durableStore = new CodexProfileObservationStore({ managerRoot });
    let releaseReplace!: () => void;
    const replaceReleased = new Promise<void>((resolve) => { releaseReplace = resolve; });
    let replaceStarted!: () => void;
    const started = new Promise<void>((resolve) => { replaceStarted = resolve; });
    const observationStore = {
      get: durableStore.get.bind(durableStore),
      remove: durableStore.remove.bind(durableStore),
      replace: async (...args: Parameters<CodexProfileObservationStore["replace"]>) => {
        replaceStarted();
        await replaceReleased;
        return await durableStore.replace(...args);
      },
    };
    const runtimeIdentity = {
      canonicalPath: "/canonical/bin/codex",
      codexStateRoot: "/unused-before-create",
      codexSqliteRoot: "/unused-before-create",
      version: "codex-cli 0.144.4",
      fileIdentity: "1:2:3:4",
      schemaHash: "schema-hash",
    };
    const qualifier: CodexRuntimeQualifierLike = {
      qualify: vi.fn(async (_codexBin, runtimeContext) => ({
        status: "qualified" as const,
        version: runtimeIdentity.version,
        identity: { ...runtimeIdentity, ...runtimeContext },
      })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    const loginRunner = { start: vi.fn(async () => {}), wait: vi.fn(async () => {}), cancel: vi.fn(async () => {}) };
    const gateway = {
      readAccount: vi.fn(async () => ({ account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const }, providerRequiresOpenAiAuth: false })),
      readRateLimits: vi.fn(async () => ({
        rateLimits: { limitId: "codex", limitName: "Codex", primary: null, secondary: null, plan: "pro" as const },
        rateLimitsByLimitId: null,
        resetCredits: { availableCount: 1, credits: null },
      })),
      close: vi.fn(async () => {}),
    };
    const service = new CodexProfileOnboardingService({
      registry,
      observationStore,
      loginRunner,
      codexBin: "/trusted/bin/codex",
      qualifier,
      startReadGateway: vi.fn(async () => gateway),
    });
    await service.create();
    const candidate = await service.observe(profileId);

    const confirmation = service.confirm(profileId, { confirmed: true, email: candidate.account.email, plan: candidate.account.plan });
    await started;
    const cancellation = service.cancel(profileId);
    releaseReplace();
    const results = await Promise.allSettled([confirmation, cancellation]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const storedProfile = await new CodexLoginProfileRegistry({ managerRoot }).get(profileId).catch(() => null);
    const storedObservation = await new CodexProfileObservationStore({ managerRoot }).get(profileId);
    expect(storedProfile?.status === "confirmed").toBe(storedObservation !== null);
  });
});
