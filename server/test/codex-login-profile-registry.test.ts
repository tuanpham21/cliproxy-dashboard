import { link, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { codexLoginProfilesManagerRoot } from "../paths.js";
import { makeTempRoot } from "./helpers.js";

describe("Codex Login Profile registry", () => {
  it("derives the manager root beside the server-owned dashboard state file", () => {
    expect(codexLoginProfilesManagerRoot("/private/dashboard-state/quota-snapshots.json")).toBe(
      "/private/dashboard-state/codex-login-profiles",
    );
  });

  it("creates an opaque pending profile under an owner-private server-derived root", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_M8JcV6Qq0YxE2kT4uN7sP9aB",
    });

    const profile = await registry.create();

    expect(profile).toMatchObject({ id: "profile_M8JcV6Qq0YxE2kT4uN7sP9aB", status: "pending" });
    expect(profile.runtimeContext.codexSqliteRoot).toBe(profile.runtimeContext.codexStateRoot);
    expect(path.dirname(profile.runtimeContext.codexStateRoot)).toBe(await realpath(path.join(managerRoot, "profiles")));
    expect(path.basename(profile.runtimeContext.codexStateRoot)).toMatch(/^\.profile_[A-Za-z0-9_-]+\.[a-f0-9]{24}\.profile$/);
    expect((await lstat(managerRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(profile.runtimeContext.codexStateRoot)).mode & 0o777).toBe(0o700);
    const stateName = (await readdir(managerRoot)).find((name) => name.startsWith(".registry-state."))!;
    expect((await lstat(path.join(managerRoot, stateName))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(managerRoot, stateName), "utf8")).not.toContain("email");
  });

  it("gets, confirms, and cancels only pending server-derived profile roots", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_B2fK9mQ4xT7sN6vR3pL8dH1c";
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const created = await registry.create();

    await expect(registry.get(profileId)).resolves.toEqual(created);
    await expect(registry.confirm(profileId)).resolves.toMatchObject({ id: profileId, status: "confirmed" });
    await expect(registry.cancel(profileId)).rejects.toThrow("Codex Login Profile registry unavailable.");
  });

  it("removes a pending managed root and rejects path-like or symlink-swapped roots", async () => {
    const tempRoot = await makeTempRoot();
    const managerRoot = path.join(tempRoot, "dashboard-state", "codex-login-profiles");
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_Z7qP4mX8cV2nL6sR9dK3tB5h",
    });
    const profile = await registry.create();

    await expect(registry.get("../../outside-private-root")).rejects.toThrow("Codex Login Profile registry unavailable.");
    await registry.cancel(profile.id);
    await expect(lstat(profile.runtimeContext.codexStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(registry.get(profile.id)).rejects.toThrow("Codex Login Profile registry unavailable.");

    const secondRegistry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_W4nM7cQ2vX9sL5pR8dK6tB3h",
    });
    const second = await secondRegistry.create();
    await rm(second.runtimeContext.codexStateRoot, { recursive: true });
    await symlink(tempRoot, second.runtimeContext.codexStateRoot);
    await expect(secondRegistry.get(second.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
  });

  it("rejects a symlinked dashboard-state ancestor", async () => {
    const tempRoot = await makeTempRoot();
    const realStateRoot = path.join(tempRoot, "real-dashboard-state");
    const linkedStateRoot = path.join(tempRoot, "linked-dashboard-state");
    await mkdir(realStateRoot, { mode: 0o700 });
    await symlink(realStateRoot, linkedStateRoot);
    const registry = new CodexLoginProfileRegistry({
      managerRoot: path.join(linkedStateRoot, "codex-login-profiles"),
      generateId: () => "profile_N7qL4mX2cV8sP5rK9dB6tH3w",
    });

    await expect(registry.create()).rejects.toThrow("Codex Login Profile registry unavailable.");
  });

  it("secures registry metadata with private Windows DACL checks", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const windowsSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      secureCreatedFile: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async () => {}),
    };
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      platform: "win32",
      windowsSecurity,
      generateId: () => "profile_Q4nM7cX2vL9sP5rK8dB6tH3w",
    });

    await registry.create();

    expect(windowsSecurity.secureCreatedFile).toHaveBeenCalled();
    expect(windowsSecurity.verifyPrivatePath).toHaveBeenCalledWith(
      expect.stringMatching(/\.registry-state\.[1-9][0-9]*\.json$/),
      true,
    );
  });

  it("preserves a committed profile root when Windows state verification fails afterward", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_V4nM7cX2lP9sR5kQ8dB6tH3w";
    let stateVerifications = 0;
    const windowsSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      secureCreatedFile: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async (targetPath: string) => {
        if (/\.registry-state\.[1-9][0-9]*\.json$/.test(targetPath) && ++stateVerifications === 2) {
          throw new Error("synthetic committed-state verification failure");
        }
      }),
    };
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      platform: "win32",
      windowsSecurity,
      generateId: () => profileId,
    });

    await expect(registry.create()).rejects.toThrow("Codex Login Profile registry unavailable.");
    const restarted = new CodexLoginProfileRegistry({ managerRoot, platform: "win32", windowsSecurity });
    await expect(restarted.get(profileId)).resolves.toMatchObject({ id: profileId, status: "pending" });
  });

  it("serializes concurrent creates without losing either profile", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = ["profile_C4nM7cX2vL9sP5rK8dB6tH3w", "profile_D5nM8cX3vL2sP6rK9dB7tH4w"];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "" });

    const created = await Promise.all([registry.create(), registry.create()]);

    await expect(registry.get(created[0]!.id)).resolves.toMatchObject({ status: "pending" });
    await expect(registry.get(created[1]!.id)).resolves.toMatchObject({ status: "pending" });
  });

  it("serializes confirm against cancel so exactly one terminal mutation wins", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_E6nM9cX4vL3sP7rK2dB8tH5w",
    });
    const created = await registry.create();

    const outcomes = await Promise.allSettled([registry.confirm(created.id), registry.cancel(created.id)]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    if (outcomes[0]?.status === "fulfilled") {
      await expect(registry.get(created.id)).resolves.toMatchObject({ status: "confirmed" });
    } else {
      await expect(registry.get(created.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    }
  });

  it("keeps successful cancellation churn bounded without degrading unrelated operations", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    let sequence = 0;
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => `profile_churn_${String(sequence++).padStart(24, "0")}`,
    });

    for (let index = 0; index < 24; index += 1) {
      const profile = await registry.create();
      await registry.cancel(profile.id);
    }
    const unrelated = await registry.create();
    const confirmed = await registry.confirm(unrelated.id);

    await expect(registry.get(unrelated.id)).resolves.toEqual(confirmed);
    expect((await readdir(path.join(managerRoot, "profiles"))).filter((name) => name.includes(".cancel"))).toEqual([]);
    expect((await readdir(managerRoot)).filter((name) => name.startsWith(".registry-state."))).toHaveLength(1);
  });

  it("does not let a stale cleanup delete a newer generation", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = ["profile_S4nM7cX2vL9sP5rK8dB6tH3w", "profile_T5nM8cX3vL2sP6rK9dB7tH4w"];
    const leaveCleanup = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => ids.shift() ?? "",
      removePath: async () => {
        const error = new Error("synthetic cleanup failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    });
    const canceled = await leaveCleanup.create();
    const unrelated = await leaveCleanup.create();
    await expect(leaveCleanup.cancel(canceled.id)).rejects.toThrow("Codex Login Profile registry unavailable.");

    let releaseCleanup!: () => void;
    const cleanupReleased = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let signalCleanup!: () => void;
    const cleanupAttempted = new Promise<void>((resolve) => { signalCleanup = resolve; });
    const staleRegistry = new CodexLoginProfileRegistry({
      managerRoot,
      removePath: async () => {
        signalCleanup();
        await cleanupReleased;
        const error = new Error("synthetic stale cleanup failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    });
    const staleRead = staleRegistry.get(unrelated.id);
    await cleanupAttempted;
    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(unrelated.id)).resolves.toEqual(unrelated);
    releaseCleanup();

    await expect(staleRead).resolves.toEqual(unrelated);
    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(unrelated.id)).resolves.toEqual(unrelated);
    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(canceled.id)).rejects.toThrow(
      "Codex Login Profile registry unavailable.",
    );
  });

  it("fences a stale cross-instance confirm and prevents canceled opaque-id reuse", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const canceledId = "profile_R8nM3cX6vL5sP9kQ4dB2tH7w";
    const cancelingRegistry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => canceledId });
    let releaseCommit!: () => void;
    const commitReleased = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let signalCommit!: () => void;
    const commitAttempted = new Promise<void>((resolve) => { signalCommit = resolve; });
    let blockCommit = true;
    const linkPath: typeof link = async (existingPath, newPath) => {
      if (blockCommit && path.basename(newPath.toString()).startsWith(".registry-state.")) {
        blockCommit = false;
        signalCommit();
        await commitReleased;
      }
      await link(existingPath, newPath);
    };
    const olderRegistry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => canceledId, linkPath });
    const canceled = await cancelingRegistry.create();
    const staleConfirm = olderRegistry.confirm(canceled.id);
    await commitAttempted;

    await cancelingRegistry.cancel(canceled.id);
    releaseCommit();

    await expect(staleConfirm).rejects.toThrow("Codex Login Profile registry unavailable.");
    const replacement = await olderRegistry.create();
    expect(replacement.id).not.toBe(canceled.id);
    await expect(olderRegistry.get(canceled.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(lstat(canceled.runtimeContext.codexStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back a newly created root when generation commit fails", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    let stateLinks = 0;
    const linkPath: typeof link = async (existingPath, newPath) => {
      if (path.basename(newPath.toString()).startsWith(".registry-state.") && ++stateLinks === 2) {
        const error = new Error("synthetic state commit failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      await link(existingPath, newPath);
    };
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_F7nM2cX5vL4sP8rK3dB9tH6w",
      linkPath,
    });

    await expect(registry.create()).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(readdir(path.join(managerRoot, "profiles"))).resolves.toEqual([]);
  });

  it("keeps cancellation forward-only when rollback races another process moving the root", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_N6mC9xV4lP3sR7kQ2dB8tH5w";
    let failMoveCommit = true;
    const movingRegistry = new CodexLoginProfileRegistry({
      managerRoot,
      linkPath: async (existingPath, newPath) => {
        if (failMoveCommit) {
          failMoveCommit = false;
          const error = new Error("synthetic post-move commit failure") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
        await link(existingPath, newPath);
      },
    });
    let reservationSeen = false;
    let movedDuringRollback = false;
    const linkPath: typeof link = async (existingPath, newPath) => {
      const state = JSON.parse(await readFile(existingPath, "utf8")) as {
        profiles: Array<{ id: string; cancelingRootName?: string }>;
      };
      const entry = state.profiles.find((candidate) => candidate.id === profileId);
      if (entry?.cancelingRootName) reservationSeen = true;
      if (reservationSeen && entry && !entry.cancelingRootName) {
        movedDuringRollback = true;
        await movingRegistry.get(profileId).catch(() => {});
      }
      await link(existingPath, newPath);
    };
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => profileId,
      renamePath: async () => {
        const error = new Error("synthetic pre-rename failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
      linkPath,
    });
    const created = await registry.create();

    await expect(registry.cancel(created.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    if (!movedDuringRollback) await movingRegistry.get(created.id).catch(() => {});
    const recovered = new CodexLoginProfileRegistry({ managerRoot });
    await expect(recovered.get(created.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(lstat(created.runtimeContext.codexStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(path.join(managerRoot, "profiles"))).filter((name) => name.includes(".cancel"))).toEqual([]);
  });

  it("recovers after root rename when generation replacement fails", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    let createdRoot = "";
    let failNextCommit = false;
    const renamePath: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (path.basename(oldPath.toString()) === path.basename(createdRoot) && newPath.toString().endsWith(".canceling")) {
        failNextCommit = true;
      }
    };
    const linkPath: typeof link = async (existingPath, newPath) => {
      if (failNextCommit && path.basename(newPath.toString()).startsWith(".registry-state.")) {
        failNextCommit = false;
        const error = new Error("synthetic post-rename commit failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      await link(existingPath, newPath);
    };
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_G8nM3cX6vL5sP9rK4dB2tH7w",
      renamePath,
      linkPath,
    });
    const created = await registry.create();
    createdRoot = created.runtimeContext.codexStateRoot;

    await expect(registry.cancel(created.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    const restarted = new CodexLoginProfileRegistry({ managerRoot });
    await expect(restarted.get(created.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    expect((await readdir(path.join(managerRoot, "profiles"))).filter((name) => name.includes(".cancel"))).toEqual([]);
  });

  it("recovers a committed cancellation after Windows state-file verification fails", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    let createdRoot = "";
    let failStateVerification = false;
    const windowsSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      secureCreatedFile: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async (targetPath: string) => {
        if (failStateVerification && /\.registry-state\.[1-9][0-9]*\.json$/.test(targetPath)) {
          failStateVerification = false;
          throw new Error("synthetic state verification failure");
        }
      }),
    };
    const renamePath: typeof rename = async (oldPath, newPath) => {
      await rename(oldPath, newPath);
      if (path.basename(oldPath.toString()) === path.basename(createdRoot) && newPath.toString().endsWith(".canceling")) {
        failStateVerification = true;
      }
    };
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      platform: "win32",
      windowsSecurity,
      generateId: () => "profile_J2nM5cX8vL7sP3rK6dB4tQ9w",
      renamePath,
    });
    const created = await registry.create();
    createdRoot = created.runtimeContext.codexStateRoot;

    await expect(registry.cancel(created.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    const restarted = new CodexLoginProfileRegistry({ managerRoot, platform: "win32", windowsSecurity });
    await expect(restarted.get(created.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    expect((await readdir(path.join(managerRoot, "profiles"))).filter((name) => name.includes(".cancel"))).toEqual([]);
  });

  it("removes a legacy canceled active root after registry metadata was compacted", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profilesRoot = path.join(managerRoot, "profiles");
    const canceledId = "profile_A3nM6cX9vL8sP4rQ7dB5tH2w";
    const markerName = `.${canceledId}.canceled.json`;
    await mkdir(path.join(profilesRoot, canceledId), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(profilesRoot, markerName),
      `${JSON.stringify({ schemaVersion: 1, id: canceledId, cancelingRootName: `.${canceledId}.${"a".repeat(24)}.canceling` })}\n`,
      { mode: 0o600 },
    );
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_B4nM7cX2vL9sP5rK8dB6tH3w",
    });

    const created = await registry.create();

    await expect(lstat(path.join(profilesRoot, canceledId))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(path.join(profilesRoot, markerName))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(profilesRoot)).toEqual([path.basename(created.runtimeContext.codexStateRoot)]);
  });

  it("fails closed for malformed or cross-ID legacy cancellation markers", async () => {
    const canceledId = "profile_E7nM2cX5vL4sP8rK3dB9tH6w";
    const invalidMarkers = [
      { schemaVersion: 2, id: canceledId, cancelingRootName: `.${canceledId}.${"a".repeat(24)}.canceling` },
      { schemaVersion: 1, id: "profile_F8nM3cX6vL5sP9rK4dB2tH7w", cancelingRootName: `.${canceledId}.${"b".repeat(24)}.canceling` },
    ];
    for (const marker of invalidMarkers) {
      const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
      const profilesRoot = path.join(managerRoot, "profiles");
      const activeRoot = path.join(profilesRoot, canceledId);
      const markerPath = path.join(profilesRoot, `.${canceledId}.canceled.json`);
      await mkdir(activeRoot, { recursive: true, mode: 0o700 });
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });

      await expect(new CodexLoginProfileRegistry({ managerRoot }).create()).rejects.toThrow(
        "Codex Login Profile registry unavailable.",
      );
      await expect(lstat(activeRoot)).resolves.toMatchObject({ mode: expect.any(Number) });
      await expect(lstat(markerPath)).resolves.toMatchObject({ mode: expect.any(Number) });
    }
  });

  it("removes a canonical active root with multiple legacy canceling roots and no marker", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profilesRoot = path.join(managerRoot, "profiles");
    const canceledId = "profile_C5nM8cX3vL2sP6rK9dB7tH4w";
    const unrelatedId = "profile_D6nM9cX4vL3sP7rK2dB8tH5w";
    const cancelingRoots = [
      `.${canceledId}.${"f".repeat(24)}.canceling`,
      `.${canceledId}.${"a".repeat(24)}.canceling`,
    ];
    await mkdir(profilesRoot, { recursive: true, mode: 0o700 });
    await mkdir(path.join(profilesRoot, canceledId), { mode: 0o700 });
    await mkdir(path.join(profilesRoot, unrelatedId), { mode: 0o700 });
    for (const name of cancelingRoots) await mkdir(path.join(profilesRoot, name), { mode: 0o700 });
    await writeFile(
      path.join(managerRoot, "registry.json"),
      `${JSON.stringify({ schemaVersion: 1, profiles: [{ id: canceledId, status: "pending" }, { id: unrelatedId, status: "pending" }] })}\n`,
      { mode: 0o600 },
    );
    const registry = new CodexLoginProfileRegistry({ managerRoot });

    await expect(registry.get(unrelatedId)).resolves.toMatchObject({ id: unrelatedId, status: "pending" });

    await expect(registry.get(canceledId)).rejects.toThrow("Codex Login Profile registry unavailable.");
    expect(await readdir(profilesRoot)).toEqual([unrelatedId]);
  });

  it("recovers canceling-only migration across commit and cleanup failures", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profilesRoot = path.join(managerRoot, "profiles");
    const canceledId = "profile_G9nM4cX7vL6sP2rK5dB3tQ8w";
    const activeRoot = path.join(profilesRoot, canceledId);
    const cancelingRoots = [
      path.join(profilesRoot, `.${canceledId}.${"a".repeat(24)}.canceling`),
      path.join(profilesRoot, `.${canceledId}.${"f".repeat(24)}.canceling`),
    ];
    await mkdir(activeRoot, { recursive: true, mode: 0o700 });
    for (const root of cancelingRoots) await mkdir(root, { mode: 0o700 });
    const failedCommit = new CodexLoginProfileRegistry({
      managerRoot,
      linkPath: async () => {
        const error = new Error("synthetic migration commit failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    });

    await expect(failedCommit.create()).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(lstat(activeRoot)).resolves.toMatchObject({ mode: expect.any(Number) });
    let failActiveCleanup = true;
    const recovering = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => "profile_H2nM5cX8vL7sP3rK6dB4tQ9w",
      removePath: async (targetPath, options) => {
        if (failActiveCleanup && targetPath === activeRoot) {
          failActiveCleanup = false;
          throw new Error("synthetic active-root cleanup failure");
        }
        await rm(targetPath, options);
      },
    });
    const created = await recovering.create();
    await expect(lstat(activeRoot)).resolves.toMatchObject({ mode: expect.any(Number) });

    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(created.id)).resolves.toEqual(created);
    await expect(lstat(activeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    for (const root of cancelingRoots) await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates legacy cancellation markers once, then removes active and canceling roots", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profilesRoot = path.join(managerRoot, "profiles");
    const canceledId = "profile_K3nM6cX9vL8sP4rQ7dB5tH2w";
    const unrelatedId = "profile_M5nC8xV3lP2sR6kQ9dB7tH4w";
    const cancelingRootName = `.${canceledId}.${"a".repeat(24)}.canceling`;
    const laterCancelingRootName = `.${canceledId}.${"f".repeat(24)}.canceling`;
    await mkdir(path.join(profilesRoot, cancelingRootName), { recursive: true, mode: 0o700 });
    await mkdir(path.join(profilesRoot, canceledId), { mode: 0o700 });
    await mkdir(path.join(profilesRoot, unrelatedId), { mode: 0o700 });
    await writeFile(
      path.join(managerRoot, "registry.json"),
      `${JSON.stringify({ schemaVersion: 1, profiles: [{ id: canceledId, status: "pending" }, { id: unrelatedId, status: "pending" }] })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(profilesRoot, `.${canceledId}.canceled.json`),
      `${JSON.stringify({ schemaVersion: 1, id: canceledId, cancelingRootName })}\n`,
      { mode: 0o600 },
    );
    await mkdir(path.join(profilesRoot, laterCancelingRootName), { mode: 0o700 });
    const registry = new CodexLoginProfileRegistry({ managerRoot });

    await expect(registry.get(unrelatedId)).resolves.toMatchObject({ id: unrelatedId, status: "pending" });
    await expect(registry.get(canceledId)).rejects.toThrow("Codex Login Profile registry unavailable.");
    expect(await readdir(profilesRoot)).toEqual([unrelatedId]);
  });

  it("retries partial committed cleanup without blocking unrelated profiles", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [
      "profile_H9nM4cX7vL6sP2rK5dB3tQ8w",
      "profile_M5nC8xV3lP2sR6kQ9dB7tH4w",
      "profile_P7mC2xV5lN4sR8kQ3dB9tH6w",
    ];
    let failRemoval = true;
    const removePath = vi.fn(async (targetPath: string, options: { recursive: true; force: boolean }) => {
      if (failRemoval && targetPath.endsWith(".canceling")) {
        const error = new Error("synthetic remove failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      await rm(targetPath, options);
    });
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift() ?? "", removePath });
    const canceled = await registry.create();
    const unrelated = await registry.create();

    await expect(registry.cancel(canceled.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    const confirmed = await registry.confirm(unrelated.id);
    const another = await registry.create();
    await expect(registry.get(unrelated.id)).resolves.toEqual(confirmed);
    await expect(registry.get(another.id)).resolves.toEqual(another);
    await expect(registry.get(canceled.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(registry.cancel(another.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    failRemoval = false;
    await expect(registry.get(unrelated.id)).resolves.toEqual(confirmed);
    expect((await readdir(path.join(managerRoot, "profiles"))).filter((name) => name.includes(".cancel"))).toEqual([]);
  });
});
