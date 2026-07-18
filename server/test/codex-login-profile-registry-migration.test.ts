import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { makeTempRoot } from "./helpers.js";

const canceledId = "profile_L4nM7cX2vP9sR5kQ8dB6tH3w";
const unrelatedId = "profile_M5nC8xV3lP2sR6kQ9dB7tH4w";

async function writeLegacyRegistry(managerRoot: string): Promise<void> {
  await writeFile(
    path.join(managerRoot, "registry.json"),
    `${JSON.stringify({ schemaVersion: 1, profiles: [{ id: unrelatedId, status: "pending" }] })}\n`,
    { mode: 0o600 },
  );
}

describe("Codex Login Profile registry legacy cancellation migration", () => {
  it.each(["marker", "canceling-root"] as const)("settles a %s when the canonical active root is absent", async (kind) => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profilesRoot = path.join(managerRoot, "profiles");
    await mkdir(path.join(profilesRoot, unrelatedId), { recursive: true, mode: 0o700 });
    await writeLegacyRegistry(managerRoot);
    if (kind === "marker") {
      await writeFile(
        path.join(profilesRoot, `.${canceledId}.canceled.json`),
        `${JSON.stringify({ schemaVersion: 1, id: canceledId, cancelingRootName: `.${canceledId}.${"a".repeat(24)}.canceling` })}\n`,
        { mode: 0o600 },
      );
    } else {
      await mkdir(path.join(profilesRoot, `.${canceledId}.${"a".repeat(24)}.canceling`), { mode: 0o700 });
    }

    const registry = new CodexLoginProfileRegistry({ managerRoot });

    await expect(registry.get(unrelatedId)).resolves.toMatchObject({ id: unrelatedId });
    expect(await readdir(profilesRoot)).toEqual([unrelatedId]);
  });

  it("retries when another process removes a discovered marker during settlement", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profilesRoot = path.join(managerRoot, "profiles");
    const markerPath = path.join(profilesRoot, `.${canceledId}.canceled.json`);
    await mkdir(path.join(profilesRoot, canceledId), { recursive: true, mode: 0o700 });
    await mkdir(path.join(profilesRoot, unrelatedId), { mode: 0o700 });
    await writeLegacyRegistry(managerRoot);
    await writeFile(
      markerPath,
      `${JSON.stringify({ schemaVersion: 1, id: canceledId, cancelingRootName: `.${canceledId}.${"a".repeat(24)}.canceling` })}\n`,
      { mode: 0o600 },
    );
    let releaseMarker!: () => void;
    const markerReleased = new Promise<void>((resolve) => { releaseMarker = resolve; });
    let signalMarker!: () => void;
    const markerReached = new Promise<void>((resolve) => { signalMarker = resolve; });
    let blocked = false;
    const blockedSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      secureCreatedFile: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async (targetPath: string) => {
        if (!blocked && targetPath === markerPath) {
          blocked = true;
          signalMarker();
          await markerReleased;
        }
      }),
    };
    const noOpSecurity = {
      secureCreatedDirectory: vi.fn(async () => {}),
      secureCreatedFile: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async () => {}),
    };
    const staleRegistry = new CodexLoginProfileRegistry({
      managerRoot,
      platform: "win32",
      windowsSecurity: blockedSecurity,
    });
    const winningRegistry = new CodexLoginProfileRegistry({
      managerRoot,
      platform: "win32",
      windowsSecurity: noOpSecurity,
    });
    const staleRead = staleRegistry.get(unrelatedId);
    await markerReached;

    await expect(winningRegistry.get(unrelatedId)).resolves.toMatchObject({ id: unrelatedId });
    releaseMarker();

    await expect(staleRead).resolves.toMatchObject({ id: unrelatedId });
    await expect(lstat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(profilesRoot)).toEqual([unrelatedId]);
  });

  it("never lets a failed CAS loser unlink the winner's committed generation", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const profileId = "profile_N6mC9xV4lP3sR7kQ2dB8tH5w";
    const setupRegistry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => profileId });
    const created = await setupRegistry.create();
    let releaseLosingLink!: () => void;
    const losingLinkReleased = new Promise<void>((resolve) => { releaseLosingLink = resolve; });
    let signalLosingLink!: () => void;
    const losingLinkReached = new Promise<void>((resolve) => { signalLosingLink = resolve; });
    const losingRegistry = new CodexLoginProfileRegistry({
      managerRoot,
      linkPath: async () => {
        signalLosingLink();
        await losingLinkReleased;
        const error = new Error("synthetic failed CAS link") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      },
    });
    const losingConfirm = losingRegistry.confirm(created.id);
    await losingLinkReached;

    const confirmed = await new CodexLoginProfileRegistry({ managerRoot }).confirm(created.id);
    releaseLosingLink();

    await expect(losingConfirm).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(new CodexLoginProfileRegistry({ managerRoot }).get(created.id)).resolves.toEqual(confirmed);
  });
});
