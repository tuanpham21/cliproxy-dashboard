import { chmod, link, lstat, readdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexProfileObservationStore } from "../codex-profile-observation-store.js";
import { makeTempRoot } from "./helpers.js";

const profileId = "profile_C6nM9cX4vL3sP7rK2dB8tH5w";
const secondProfileId = "profile_D7nM2cX5vL4sP8rK3dB9tH6w";

function snapshot(observedAt: string, usedPercent: number) {
  return {
    account: { email: "operator@example.com", plan: "pro" },
    observedAt,
    usage: {
      primary: { usedPercent, durationMinutes: 300, resetsAt: "2026-07-20T00:00:00.000Z" },
      secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: null },
    },
    resetCredits: { availableCount: 2 },
    runtimeVersion: "codex-cli 0.144.4",
    freshness: "fresh" as const,
  };
}

describe("Codex Profile Observation Store", () => {
  it("atomically replaces one latest owner-private snapshot and marks it non-current after restart", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const store = new CodexProfileObservationStore({ managerRoot });

    await expect(store.replace(profileId, null, snapshot("2026-07-19T04:00:00.000Z", 25))).resolves.toMatchObject({
      generation: 1,
      snapshot: { freshness: "fresh", usage: { primary: { usedPercent: 25 } } },
    });
    await expect(store.replace(profileId, 1, snapshot("2026-07-19T05:00:00.000Z", 30))).resolves.toMatchObject({
      generation: 2,
      snapshot: { freshness: "fresh", usage: { primary: { usedPercent: 30 } } },
    });

    const observationsRoot = path.join(managerRoot, "observations");
    const retained = (await readdir(observationsRoot)).filter((name) => name.includes(".observation."));
    expect(retained).toHaveLength(1);
    expect((await lstat(observationsRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(observationsRoot, retained[0]!))).mode & 0o777).toBe(0o600);

    const restarted = new CodexProfileObservationStore({ managerRoot });
    await expect(restarted.get(profileId)).resolves.toEqual({
      generation: 2,
      snapshot: { ...snapshot("2026-07-19T05:00:00.000Z", 30), freshness: "latest-known" },
    });
  });

  it("lists and removes only the selected profile snapshot", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(profileId, null, snapshot("2026-07-19T04:00:00.000Z", 25));
    await store.replace(secondProfileId, null, snapshot("2026-07-19T05:00:00.000Z", 40));

    await expect(store.list([secondProfileId, profileId])).resolves.toMatchObject([
      { profileId: secondProfileId, generation: 1 },
      { profileId, generation: 1 },
    ]);
    await store.remove(profileId);

    await expect(store.get(profileId)).resolves.toBeNull();
    await expect(store.get(secondProfileId)).resolves.toMatchObject({
      generation: 1,
      snapshot: { usage: { primary: { usedPercent: 40 } } },
    });
  });

  it("rejects secret-bearing or history-shaped snapshots instead of silently stripping fields", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const store = new CodexProfileObservationStore({ managerRoot });
    const valid = snapshot("2026-07-19T04:00:00.000Z", 25);
    const forbidden = [
      { ...valid, token: "provider-secret" },
      { ...valid, account: { ...valid.account, workspaceId: "workspace-1" } },
      { ...valid, resetCredits: { ...valid.resetCredits, creditIds: ["credit-1"] } },
      { ...valid, rawResponse: { internal: true } },
      { ...valid, history: [valid] },
    ];

    for (const value of forbidden) {
      await expect(store.replace(profileId, null, value as never)).rejects.toMatchObject({
        code: "invalid-snapshot",
        message: "Codex Profile Observation Store unavailable.",
      });
    }
    await expect(store.get(profileId)).resolves.toBeNull();
  });

  it("fences a stale cross-process replacement", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const first = new CodexProfileObservationStore({ managerRoot });
    await first.replace(profileId, null, snapshot("2026-07-19T04:00:00.000Z", 25));
    const stale = new CodexProfileObservationStore({ managerRoot });
    const winner = new CodexProfileObservationStore({ managerRoot });
    expect((await stale.get(profileId))?.generation).toBe(1);
    expect((await winner.get(profileId))?.generation).toBe(1);

    await winner.replace(profileId, 1, snapshot("2026-07-19T05:00:00.000Z", 30));
    await expect(stale.replace(profileId, 1, snapshot("2026-07-19T06:00:00.000Z", 90))).rejects.toMatchObject({
      code: "stale-generation",
    });
    await expect(new CodexProfileObservationStore({ managerRoot }).get(profileId)).resolves.toMatchObject({
      generation: 2,
      snapshot: { usage: { primary: { usedPercent: 30 } } },
    });
  });

  it("fails closed and bounds retained generations when old evidence cannot be compacted", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const removePath = vi.fn(async (targetPath: string) => {
      if (targetPath.endsWith(".observation.1.json")) {
        throw Object.assign(new Error("compaction blocked"), { code: "EACCES" });
      }
      await rm(targetPath, { force: true });
    });
    const store = new CodexProfileObservationStore({ managerRoot, removePath });
    await store.replace(profileId, null, snapshot("2026-07-19T04:00:00.000Z", 25));

    await expect(store.replace(profileId, 1, snapshot("2026-07-19T05:00:00.000Z", 30))).rejects.toMatchObject({
      code: "unavailable",
    });
    const observationsRoot = path.join(managerRoot, "observations");
    expect((await readdir(observationsRoot)).filter((name) => name.includes(".observation."))).toHaveLength(2);

    await expect(store.replace(profileId, 2, snapshot("2026-07-19T06:00:00.000Z", 35))).rejects.toMatchObject({
      code: "unavailable",
    });
    expect((await readdir(observationsRoot)).filter((name) => name.includes(".observation."))).toHaveLength(2);
  });

  it("reconciles orphan snapshots and crash-left private temp files", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const store = new CodexProfileObservationStore({ managerRoot });
    await store.replace(profileId, null, snapshot("2026-07-19T04:00:00.000Z", 25));
    const observationsRoot = path.join(managerRoot, "observations");
    const tempPath = path.join(observationsRoot, ".observation.0123456789abcdef01234567.tmp");
    await writeFile(tempPath, "private crash residue\n", { mode: 0o600 });
    await chmod(tempPath, 0o600);
    const staleTime = new Date(Date.now() - 120_000);
    await utimes(tempPath, staleTime, staleTime);

    await store.reconcile([]);

    expect(await readdir(observationsRoot)).toEqual([]);
  });

  it("does not delete a live cross-process temp before its atomic link commit", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    let releaseLink!: () => void;
    const linkReleased = new Promise<void>((resolve) => { releaseLink = resolve; });
    let linkStarted!: () => void;
    const started = new Promise<void>((resolve) => { linkStarted = resolve; });
    const writer = new CodexProfileObservationStore({
      managerRoot,
      linkPath: async (sourcePath, targetPath) => {
        linkStarted();
        await linkReleased;
        await link(sourcePath, targetPath);
      },
    });
    const replacement = writer.replace(profileId, null, snapshot("2026-07-19T04:00:00.000Z", 25));
    await started;

    await new CodexProfileObservationStore({ managerRoot }).reconcile([profileId]);
    releaseLink();

    await expect(replacement).resolves.toMatchObject({ generation: 1 });
  });

  it("secures observation files with private Windows DACL checks", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const windowsSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      secureCreatedFile: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async () => {}),
    };
    const store = new CodexProfileObservationStore({ managerRoot, platform: "win32", windowsSecurity });

    await store.replace(profileId, null, snapshot("2026-07-19T04:00:00.000Z", 25));

    expect(windowsSecurity.secureCreatedFile).toHaveBeenCalledTimes(1);
    expect(windowsSecurity.verifyPrivatePath).toHaveBeenCalledWith(
      expect.stringMatching(/\.observation\.1\.json$/),
      true,
    );
  });
});
