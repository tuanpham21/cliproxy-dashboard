import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { makeTempRoot } from "./helpers.js";

const PROFILE_A = `profile_${"a".repeat(32)}`;
const PROFILE_B = `profile_${"b".repeat(32)}`;

describe("confirmed Codex Login Profile deletion", () => {
  it("removes only the selected confirmed profile metadata and managed root", async () => {
    const managerRoot = path.join(await makeTempRoot(), "codex-login-profiles");
    const ids = [PROFILE_A, PROFILE_B];
    const registry = new CodexLoginProfileRegistry({ managerRoot, generateId: () => ids.shift()! });
    const first = await registry.confirm((await registry.create()).id);
    const second = await registry.confirm((await registry.create()).id);

    await registry.delete(first.id);

    await expect(registry.get(first.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(registry.get(second.id)).resolves.toEqual({ ...second, order: 0 });
    await expect(lstat(first.runtimeContext.codexStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(second.runtimeContext.codexStateRoot)).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("retries committed root cleanup idempotently after a deletion failure", async () => {
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

    await expect(registry.delete(profile.id)).rejects.toThrow("Codex Login Profile registry unavailable.");
    await expect(new CodexLoginProfileRegistry({ managerRoot }).delete(profile.id)).resolves.toBeUndefined();

    await expect(lstat(profile.runtimeContext.codexStateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
