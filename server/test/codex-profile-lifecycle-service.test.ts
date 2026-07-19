import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { CodexProfileLifecycleFence } from "../codex-profile-lifecycle-fence.js";
import {
  CodexProfileLifecycleService,
  CodexProfileLifecycleServiceError,
} from "../codex-profile-lifecycle-service.js";
import { CodexProfileLifecycleStore } from "../codex-profile-lifecycle-store.js";
import { CodexProfileObservationStore } from "../codex-profile-observation-store.js";
import { makeTempRoot } from "./helpers.js";

const PROFILE_A = `profile_${"a".repeat(32)}`;
const PROFILE_B = `profile_${"b".repeat(32)}`;
const snapshot = {
  account: { email: "operator@example.com", plan: "pro" },
  observedAt: "2026-07-19T12:00:00.000Z",
  usage: { primary: null, secondary: null },
  resetCredits: { availableCount: 2 },
  runtimeVersion: "codex-cli 0.144.4",
  freshness: "fresh" as const,
};

function fence(managerRoot: string) {
  return new CodexProfileLifecycleFence({
    managerRoot,
    currentOwner: async () => ({ pid: 101, processStartIdentity: "owner-a" }),
    inspectOwner: async () => "alive",
  });
}

describe("Codex Login Profile lifecycle service", () => {
  it("blocks deletion on retained redemption state before mutating the exact profile", async () => {
    const managerRoot = path.join(await makeTempRoot(), "codex-login-profiles");
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => PROFILE_A });
    const profile = await registry.confirm((await registry.create()).id);
    const observationStore = new CodexProfileObservationStore({ managerRoot });
    await observationStore.replace(profile.id, null, snapshot);
    const service = new CodexProfileLifecycleService({
      registry,
      observationStore,
      lifecycleStore: new CodexProfileLifecycleStore({ managerRoot }),
      lifecycleFence: fence(managerRoot),
      redemptionService: { deletionDisposition: vi.fn(async () => "blocked" as const) },
    });

    await expect(service.deleteProfile(profile.id, { confirmed: true })).rejects.toEqual(
      expect.objectContaining<CodexProfileLifecycleServiceError>({ code: "redemption-active" }),
    );

    await expect(registry.get(profile.id)).resolves.toMatchObject({ enabled: true });
    await expect(observationStore.get(profile.id)).resolves.toMatchObject({ snapshot });
  });

  it("deletes metadata, snapshot, and only the selected managed root after explicit confirmation", async () => {
    const managerRoot = path.join(await makeTempRoot(), "codex-login-profiles");
    const ids = [PROFILE_A, PROFILE_B];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift()! });
    const first = await registry.confirm((await registry.create()).id);
    const second = await registry.confirm((await registry.create()).id);
    const observationStore = new CodexProfileObservationStore({ managerRoot });
    await observationStore.replace(first.id, null, snapshot);
    await observationStore.replace(second.id, null, { ...snapshot, account: { email: "second@example.com", plan: "plus" } });
    const lifecycleStore = new CodexProfileLifecycleStore({ managerRoot });
    const service = new CodexProfileLifecycleService({
      registry,
      observationStore,
      lifecycleStore,
      lifecycleFence: fence(managerRoot),
      redemptionService: { deletionDisposition: vi.fn(async () => "safe" as const) },
    });

    await expect(service.deleteProfile(first.id, { confirmed: true })).resolves.toEqual({
      profileId: first.id,
      status: "deleted",
    });

    await expect(registry.get(first.id)).rejects.toThrow();
    await expect(observationStore.get(first.id)).resolves.toBeNull();
    await expect(lstat(first.runtimeContext.codexStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(registry.get(second.id)).resolves.toMatchObject({ id: second.id, enabled: true });
    await expect(observationStore.get(second.id)).resolves.toMatchObject({ snapshot: { account: { email: "second@example.com" } } });
    await expect(lifecycleStore.listCleanupRequired()).resolves.toEqual([]);
  });

  it("retains cleanup-required state and retries partial root cleanup safely", async () => {
    const managerRoot = path.join(await makeTempRoot(), "codex-login-profiles");
    let failCleanup = true;
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => PROFILE_A,
      removePath: async (targetPath, options) => {
        if (failCleanup && targetPath.endsWith(".canceling")) {
          failCleanup = false;
          throw new Error("synthetic cleanup failure");
        }
        await rm(targetPath, options);
      },
    });
    const profile = await registry.confirm((await registry.create()).id);
    const observationStore = new CodexProfileObservationStore({ managerRoot });
    await observationStore.replace(profile.id, null, snapshot);
    const lifecycleStore = new CodexProfileLifecycleStore({ managerRoot });
    const dependencies = {
      observationStore,
      lifecycleStore,
      lifecycleFence: fence(managerRoot),
      redemptionService: { deletionDisposition: vi.fn(async () => "safe" as const) },
    };

    await expect(new CodexProfileLifecycleService({ ...dependencies, registry }).deleteProfile(profile.id, { confirmed: true }))
      .rejects.toEqual(expect.objectContaining<CodexProfileLifecycleServiceError>({ code: "cleanup-required" }));
    await expect(lifecycleStore.listCleanupRequired()).resolves.toEqual([
      { profileId: profile.id, label: profile.label, order: profile.order },
    ]);

    await expect(new CodexProfileLifecycleService({
      ...dependencies,
      registry: new CodexLoginProfileRegistry({ managerRoot }),
    }).deleteProfile(profile.id, { confirmed: true })).resolves.toMatchObject({ status: "deleted" });
    await expect(lifecycleStore.listCleanupRequired()).resolves.toEqual([]);
  });
});
