import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { CodexProfileObservationService } from "../codex-profile-observation-service.js";
import { CodexProfileObservationStore } from "../codex-profile-observation-store.js";
import { CodexProfileLifecycleStore } from "../codex-profile-lifecycle-store.js";
import type { CodexRuntimeQualifierLike } from "../codex-runtime-qualifier.js";
import { makeTempRoot } from "./helpers.js";

const firstProfileId = "profile_F9nM4cX7vL6sP2rK5dB3tH8w";
const secondProfileId = "profile_G2nM5cX8vL7sP3rK6dB4tH9w";

const retainedSnapshot = {
  account: { email: "operator@example.com", plan: "pro" },
  observedAt: "2026-07-19T04:00:00.000Z",
  usage: {
    primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2026-07-20T00:00:00.000Z" },
    secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: null },
  },
  resetCredits: { availableCount: 2 },
  runtimeVersion: "codex-cli 0.144.4",
  freshness: "fresh" as const,
};

function unusedQualifier(): CodexRuntimeQualifierLike {
  return {
    qualify: vi.fn(async () => ({ status: "runtime-unavailable" as const, code: "codex_runtime_unavailable" as const, message: "Codex runtime unavailable. Check the configured Codex path." as const })),
    matchesIdentity: vi.fn(async () => false),
    close: vi.fn(async () => {}),
  };
}

describe("Codex Profile Observation Service", () => {
  it("shows ordered latest-known rows and counts profiles with resets without pooling credits", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [firstProfileId, secondProfileId];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
    const first = await registry.create();
    const second = await registry.create();
    await registry.confirm(first.id);
    await registry.confirm(second.id);
    await registry.updateMetadata(first.id, { label: "Primary" });
    await registry.updateMetadata(second.id, { label: "Paused", enabled: false });
      await new CodexProfileObservationStore({ managerRoot }).replace(first.id, null, retainedSnapshot);
      const redemptionService = { currentState: vi.fn(async (profileId: string) => profileId === first.id ? {
        status: "ambiguous" as const,
        proposalId: "p".repeat(43),
        allowedAction: "retry-same" as const,
        selectionMode: "specific" as const,
        dispatchAt: "2026-07-19T04:10:00.000Z",
      } : { status: "not-found" as const }) };
      const service = new CodexProfileObservationService({
      registry: new CodexLoginProfileRegistry({ managerRoot }),
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: unusedQualifier(),
        startReadGateway: vi.fn(async () => { throw new Error("unused"); }),
        now: () => new Date("2026-07-19T04:15:00.000Z"),
        redemptionService,
    });

    const view = await service.list();

    expect(view.profiles).toMatchObject([
      {
        profileId: first.id,
        label: "Primary",
        enabled: true,
        order: 0,
          status: "latest-known",
          observation: { account: { email: "operator@example.com", plan: "pro" }, freshness: "latest-known" },
          activeRedemption: { status: "ambiguous", proposalId: "p".repeat(43) },
      },
      {
        profileId: second.id,
        label: "Paused",
        enabled: false,
        order: 1,
        status: "disabled",
        observation: null,
      },
    ]);
    expect(view.summary).toEqual({
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
    });
      expect(view.summary).not.toHaveProperty("totalCredits");
      expect(redemptionService.currentState).toHaveBeenCalledWith(first.id);
  });

    it("reloads selected snapshot after terminal recovery reconciliation", async () => {
      const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
      const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => firstProfileId });
      const profile = await registry.create();
      await registry.confirm(profile.id);
      const store = new CodexProfileObservationStore({ managerRoot });
      await store.replace(profile.id, null, retainedSnapshot);
      const redemptionService = { currentState: vi.fn(async () => {
        await store.replace(profile.id, 1, {
          ...retainedSnapshot,
          observedAt: "2026-07-19T05:00:00.000Z",
          usage: { ...retainedSnapshot.usage, primary: { ...retainedSnapshot.usage.primary!, usedPercent: 0 } },
        });
        return {
          status: "terminal" as const, proposalId: "t".repeat(43), allowedAction: "none" as const,
          selectionMode: "specific" as const, outcome: "reset" as const, reconciliation: "reconciled" as const,
          message: "Usage limits reset.", auditEventId: "a".repeat(43),
          createdAt: "2026-07-19T05:00:00.000Z", expiresAt: "2026-07-19T05:10:00.000Z",
        };
      }) };
      const service = new CodexProfileObservationService({
        registry, observationStore: store, codexBin: "/trusted/bin/codex", qualifier: unusedQualifier(), redemptionService,
      });

      await expect(service.list()).resolves.toMatchObject({
        profiles: [{ observation: { usage: { primary: { usedPercent: 0 } } }, activeRedemption: { status: "terminal" } }],
      });
    });

    it("derives fresh, refresh-needed, and stale states from schedule age and reset times", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [firstProfileId, secondProfileId, "profile_U4nM7cX2vL9sP5rK8dB6tQ3w"];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
    const profiles = await Promise.all([registry.create(), registry.create(), registry.create()]);
    for (const profile of profiles) await registry.confirm(profile.id);
    const store = new CodexProfileObservationStore({ managerRoot });
    const snapshots = [
      {
        ...retainedSnapshot,
        observedAt: "2026-07-19T05:31:00.000Z",
        usage: { ...retainedSnapshot.usage, primary: { ...retainedSnapshot.usage.primary!, resetsAt: "2026-07-19T07:00:00.000Z" } },
      },
      {
        ...retainedSnapshot,
        observedAt: "2026-07-19T05:50:00.000Z",
        usage: { ...retainedSnapshot.usage, primary: { ...retainedSnapshot.usage.primary!, resetsAt: "2026-07-19T05:59:00.000Z" } },
      },
      {
        ...retainedSnapshot,
        observedAt: "2026-07-19T05:29:59.000Z",
        usage: { primary: null, secondary: null },
      },
    ] as const;
    for (const [index, profile] of profiles.entries()) await store.replace(profile.id, null, snapshots[index]!);
    const service = new CodexProfileObservationService({
      registry,
      observationStore: store,
      codexBin: "/trusted/bin/codex",
      qualifier: unusedQualifier(),
      now: () => new Date("2026-07-19T06:00:00.000Z"),
    });

    const view = await service.list();

    expect(view.profiles.map((profile) => [profile.status, profile.observation?.freshness])).toEqual([
      ["fresh", "fresh"],
      ["refresh-needed", "refresh-needed"],
      ["stale", "stale"],
    ]);
    expect(view.summary).toMatchObject({ fresh: 1, refreshNeeded: 1, stale: 1 });
  });

  it("keeps retained evidence but marks it stale after a failed refresh", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => firstProfileId });
    const profile = await registry.create();
    await registry.confirm(profile.id);
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(profile.id, null, retainedSnapshot);
    const identity = {
      canonicalPath: "/canonical/bin/codex",
      ...profile.runtimeContext,
      version: "codex-cli 0.145.0",
      fileIdentity: "1:2:3:failed-refresh",
      schemaHash: "schema-hash-failed-refresh",
    };
    const qualifier: CodexRuntimeQualifierLike = {
      qualify: vi.fn(async () => ({ status: "qualified" as const, version: identity.version, identity })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    const service = new CodexProfileObservationService({
      registry,
      observationStore: store,
      codexBin: "/trusted/bin/codex",
      qualifier,
      startReadGateway: vi.fn(async () => ({
        readAccount: vi.fn(async () => { throw new Error("transient provider read failed"); }),
        readRateLimits: vi.fn(),
        close: vi.fn(async () => {}),
      })),
      now: () => new Date("2026-07-19T04:10:00.000Z"),
    });

    await expect(service.refresh(profile.id)).rejects.toMatchObject({ code: "read-failed" });

    await expect(service.list()).resolves.toMatchObject({
      profiles: [{
        profileId: profile.id,
        status: "stale",
        observation: { ...retainedSnapshot, freshness: "stale" },
      }],
      summary: { stale: 1 },
    });
  });

    it("does not open a profile read session while redemption blocks lifecycle access", async () => {
      const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
      const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => firstProfileId });
      const profile = await registry.create();
      await registry.confirm(profile.id);
      const store = new CodexProfileObservationStore({ managerRoot });
      await store.replace(profile.id, null, retainedSnapshot);
      const startReadGateway = vi.fn(async () => { throw new Error("must not start"); });
      const service = new CodexProfileObservationService({
        registry,
        observationStore: store,
        codexBin: "/trusted/bin/codex",
        qualifier: unusedQualifier(),
        startReadGateway,
        redemptionService: {
          currentState: vi.fn(async () => ({ status: "not-found" as const })),
          deletionDisposition: vi.fn(async () => "blocked" as const),
        },
      });

      await expect(service.refresh(profile.id)).rejects.toMatchObject({ code: "profile-not-refreshable" });
      expect(startReadGateway).not.toHaveBeenCalled();
    });

    it("refreshes only the selected profile through its private read-only runtime", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [
      "profile_H3nM6cX9vL8sP4rK7dB5tQ2w",
      "profile_J4nM7cX2vL9sP5rK8dB6tQ3w",
    ];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
    const selected = await registry.create();
    const unrelated = await registry.create();
    await registry.confirm(selected.id);
    await registry.confirm(unrelated.id);
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(selected.id, null, retainedSnapshot);
    await store.replace(unrelated.id, null, {
      ...retainedSnapshot,
      account: { email: "other@example.com", plan: "plus" },
      usage: { ...retainedSnapshot.usage, primary: { ...retainedSnapshot.usage.primary!, usedPercent: 70 } },
      resetCredits: { availableCount: 0 },
    });
    const runtimeIdentity = {
      canonicalPath: "/canonical/bin/codex",
      ...selected.runtimeContext,
      version: "codex-cli 0.145.0",
      fileIdentity: "1:2:3:5",
      schemaHash: "schema-hash-2",
    };
    const qualifier: CodexRuntimeQualifierLike = {
      qualify: vi.fn(async () => ({ status: "qualified" as const, version: runtimeIdentity.version, identity: runtimeIdentity })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
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
          primary: { usedPercent: 40, windowMinutes: 300, resetsAt: 1_800_000_100 },
          secondary: { usedPercent: 65, windowMinutes: 10_080, resetsAt: null },
          plan: "pro" as const,
        },
        rateLimitsByLimitId: null,
        resetCredits: { availableCount: 1, credits: null },
      })),
      close: vi.fn(async () => {}),
    };
    const startReadGateway = vi.fn(async () => gateway);
    const service = new CodexProfileObservationService({
      registry,
      observationStore: store,
      codexBin: "/trusted/bin/codex",
      qualifier,
      startReadGateway,
      now: () => new Date("2026-07-19T06:00:00.000Z"),
    });

    await expect(service.refresh(selected.id)).resolves.toMatchObject({
      profileId: selected.id,
      status: "fresh",
      observation: {
        usage: { primary: { usedPercent: 40 } },
        resetCredits: { availableCount: 1 },
        runtimeVersion: "codex-cli 0.145.0",
        freshness: "fresh",
      },
    });
    expect(startReadGateway).toHaveBeenCalledWith({
      codexBin: runtimeIdentity.canonicalPath,
      runtimeContext: selected.runtimeContext,
      qualifier,
    });
    await expect(new CodexProfileObservationStore({ managerRoot }).get(selected.id)).resolves.toMatchObject({
      generation: 2,
      snapshot: { usage: { primary: { usedPercent: 40 } } },
    });
      await expect(new CodexProfileObservationStore({ managerRoot }).get(unrelated.id)).resolves.toMatchObject({
        generation: 1,
        snapshot: { account: { email: "other@example.com" }, usage: { primary: { usedPercent: 70 } } },
      });
    });

    it("reconciles same-session redemption evidence into only the selected profile", async () => {
      const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
      const ids = [firstProfileId, secondProfileId];
      const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });
      const selected = await registry.create();
      const unrelated = await registry.create();
      await registry.confirm(selected.id);
      await registry.confirm(unrelated.id);
      const store = new CodexProfileObservationStore({ managerRoot });
      await store.replace(selected.id, null, retainedSnapshot);
      await store.replace(unrelated.id, null, { ...retainedSnapshot, account: { email: "other@example.com", plan: "plus" } });
      const identity = {
        canonicalPath: "/canonical/bin/codex",
        ...selected.runtimeContext,
        version: "codex-cli 0.145.0",
        fileIdentity: "1:2:3:reconcile",
        schemaHash: "schema-hash-reconcile",
      };
      const qualify = vi.fn(async () => ({ status: "qualified" as const, version: identity.version, identity }));
      const qualifier: CodexRuntimeQualifierLike = {
        qualify,
        matchesIdentity: vi.fn(async () => true),
        close: vi.fn(async () => {}),
      };
      const startReadGateway = vi.fn(async () => { throw new Error("must not open a second session"); });
      const service = new CodexProfileObservationService({
        registry,
        observationStore: store,
        codexBin: "/trusted/bin/codex",
        qualifier,
        startReadGateway,
      });
      const evidence = {
        account: retainedSnapshot.account,
        runtimeVersion: identity.version,
        observedAt: "2026-07-19T06:30:00.000Z",
        usage: { ...retainedSnapshot.usage, primary: { ...retainedSnapshot.usage.primary!, usedPercent: 0 } },
        resetCredits: { availableCount: 1, selectionMode: "detailed" as const, credits: [] },
      };

      await expect(service.reconcileRedemption(selected.id, evidence)).resolves.toMatchObject({
        profileId: selected.id,
        observation: { usage: { primary: { usedPercent: 0 } }, resetCredits: { availableCount: 1 } },
      });
      expect(startReadGateway).not.toHaveBeenCalled();
      await expect(store.get(unrelated.id)).resolves.toMatchObject({
        generation: 1,
        snapshot: { account: { email: "other@example.com" }, usage: { primary: { usedPercent: 25 } } },
      });

      await expect(service.reconcileRedemption(selected.id, {
        ...evidence,
        account: { email: "intruder@example.com", plan: "pro" },
      })).rejects.toMatchObject({ code: "profile-not-refreshable" });
      qualify.mockResolvedValue({
        status: "qualified",
        version: "codex-cli 0.146.0",
        identity: { ...identity, version: "codex-cli 0.146.0" },
      });
      await expect(service.reconcileRedemption(selected.id, evidence)).rejects.toMatchObject({ code: "read-failed" });
      await expect(store.get(selected.id)).resolves.toMatchObject({ generation: 2 });
    });

    it("quarantines an identity change without replacing retained usage evidence", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_K5nM8cX3vL2sP6rK9dB7tQ4w";
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const profile = await registry.create();
    await registry.confirm(profile.id);
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(profile.id, null, retainedSnapshot);
    const identity = {
      canonicalPath: "/canonical/bin/codex",
      ...profile.runtimeContext,
      version: "codex-cli 0.145.0",
      fileIdentity: "1:2:3:6",
      schemaHash: "schema-hash-3",
    };
    const qualifier: CodexRuntimeQualifierLike = {
      qualify: vi.fn(async () => ({ status: "qualified" as const, version: identity.version, identity })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    const gateway = {
      readAccount: vi.fn(async () => ({
        account: { type: "chatgpt" as const, email: "intruder@example.com", plan: "plus" as const },
        providerRequiresOpenAiAuth: false,
      })),
        readRateLimits: vi.fn(async () => { throw new Error("must not read mismatched identity usage"); }),
        close: vi.fn(async () => { throw new Error("close failed after mismatch"); }),
    };
    const service = new CodexProfileObservationService({
      registry,
      observationStore: store,
      codexBin: "/trusted/bin/codex",
      qualifier,
      startReadGateway: vi.fn(async () => gateway),
    });

      await expect(service.refresh(profile.id)).rejects.toMatchObject({
        code: "read-failed",
        message: "Codex Profile Observation unavailable.",
      });

    expect(gateway.readRateLimits).not.toHaveBeenCalled();
    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(profile.id)).resolves.toMatchObject({ enabled: false });
    await expect(new CodexProfileObservationStore({ managerRoot }).get(profile.id)).resolves.toMatchObject({
      generation: 2,
      snapshot: {
        account: retainedSnapshot.account,
        usage: retainedSnapshot.usage,
        freshness: "identity-changed",
      },
    });
    await expect(service.list()).resolves.toMatchObject({
      profiles: [{ profileId: profile.id, enabled: false, status: "identity-changed" }],
      summary: { identityChanged: 1, profilesWithResets: 0 },
    });
    await expect(service.updateMetadata(profile.id, { enabled: true })).rejects.toMatchObject({
      code: "profile-not-refreshable",
    });
    await expect(service.refresh(profile.id)).rejects.toMatchObject({ code: "identity-changed" });
    await expect(new CodexProfileObservationStore({ managerRoot }).get(profile.id)).resolves.toMatchObject({ generation: 2 });
  });

  it("shares one in-flight refresh for the same profile", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_L6nM9cX4vL3sP7rK2dB8tQ5w";
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const profile = await registry.create();
    await registry.confirm(profile.id);
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(profile.id, null, retainedSnapshot);
    const identity = {
      canonicalPath: "/canonical/bin/codex",
      ...profile.runtimeContext,
      version: "codex-cli 0.145.0",
      fileIdentity: "1:2:3:7",
      schemaHash: "schema-hash-4",
    };
    const qualifier: CodexRuntimeQualifierLike = {
      qualify: vi.fn(async () => ({ status: "qualified" as const, version: identity.version, identity })),
      matchesIdentity: vi.fn(async () => true),
      close: vi.fn(async () => {}),
    };
    let releaseRead!: () => void;
    const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
    const gateway = {
      readAccount: vi.fn(async () => ({
        account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
        providerRequiresOpenAiAuth: false,
      })),
      readRateLimits: vi.fn(async () => {
        await readReleased;
        return {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: { usedPercent: 45, windowMinutes: 300, resetsAt: null },
            secondary: null,
            plan: "pro" as const,
          },
          rateLimitsByLimitId: null,
          resetCredits: { availableCount: 1, credits: null },
        };
      }),
      close: vi.fn(async () => {}),
    };
    const startReadGateway = vi.fn(async () => gateway);
    const service = new CodexProfileObservationService({
      registry,
      observationStore: store,
      codexBin: "/trusted/bin/codex",
      qualifier,
      startReadGateway,
      now: () => new Date("2026-07-19T07:00:00.000Z"),
    });

    const firstRefresh = service.refresh(profile.id);
    const secondRefresh = service.refresh(profile.id);
    await vi.waitFor(() => expect(gateway.readRateLimits).toHaveBeenCalled());
    releaseRead();

    await expect(Promise.all([firstRefresh, secondRefresh])).resolves.toMatchObject([
      { profileId: profile.id, observation: { usage: { primary: { usedPercent: 45 } } } },
      { profileId: profile.id, observation: { usage: { primary: { usedPercent: 45 } } } },
    ]);
    expect(startReadGateway).toHaveBeenCalledTimes(1);
    await expect(new CodexProfileObservationStore({ managerRoot }).get(profile.id)).resolves.toMatchObject({ generation: 2 });
  });

  it("repairs an interrupted identity quarantine before exposing the profile list", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_P7nM2cX5vL4sP8rK3dB9tQ6w";
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const profile = await registry.create();
    await registry.confirm(profile.id);
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(profile.id, null, { ...retainedSnapshot, freshness: "identity-changed" });
    const service = new CodexProfileObservationService({
      registry: new CodexLoginProfileRegistry({ managerRoot }),
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: unusedQualifier(),
    });

    await expect(service.list()).resolves.toMatchObject({
      profiles: [{ profileId: profile.id, enabled: false, status: "identity-changed" }],
      summary: { identityChanged: 1, profilesWithResets: 0 },
    });
    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(profile.id)).resolves.toMatchObject({ enabled: false });
  });

    it("removes an orphan observation after profile cancellation recovery", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_Q8nM3cX6vL5sP9rK4dB2tQ7w";
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const profile = await registry.create();
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(profile.id, null, retainedSnapshot);
    await registry.cancel(profile.id);
    const service = new CodexProfileObservationService({
      registry: new CodexLoginProfileRegistry({ managerRoot }),
      observationStore: new CodexProfileObservationStore({ managerRoot }),
      codexBin: "/trusted/bin/codex",
      qualifier: unusedQualifier(),
    });

    await expect(service.list()).resolves.toEqual({
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
    });
    await expect(new CodexProfileObservationStore({ managerRoot }).get(profile.id)).resolves.toBeNull();
    });

    it("surfaces failed deletion as cleanup-required without exposing retained observation values", async () => {
      const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
      const lifecycleStore = new CodexProfileLifecycleStore({ managerRoot });
      const observationStore = new CodexProfileObservationStore({ managerRoot });
      await lifecycleStore.markCleanupRequired({ profileId: firstProfileId, label: "Primary", order: 0 });
      await observationStore.replace(firstProfileId, null, retainedSnapshot);
      const service = new CodexProfileObservationService({
        registry: new CodexLoginProfileRegistry({ managerRoot }),
        observationStore,
        lifecycleStore,
        codexBin: "/trusted/bin/codex",
        qualifier: unusedQualifier(),
      });

      await expect(service.list()).resolves.toMatchObject({
        profiles: [{ profileId: firstProfileId, label: "Primary", status: "cleanup-required", observation: null }],
        summary: { total: 1, cleanupRequired: 1, profilesWithResets: 0 },
      });
    });
  });
