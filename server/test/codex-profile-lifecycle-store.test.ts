import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CodexProfileLifecycleStore } from "../codex-profile-lifecycle-store.js";
import { makeTempRoot } from "./helpers.js";

const PROFILE_A = `profile_${"a".repeat(32)}`;
const PROFILE_B = `profile_${"b".repeat(32)}`;

describe("Codex Login Profile lifecycle store", () => {
  it("persists minimal cleanup-required state per opaque profile and clears only that profile", async () => {
    const managerRoot = path.join(await makeTempRoot(), "codex-login-profiles");
    const store = new CodexProfileLifecycleStore({ managerRoot });
    await store.markCleanupRequired({ profileId: PROFILE_A, label: "Primary", order: 0 });
    await store.markCleanupRequired({ profileId: PROFILE_B, label: "Secondary", order: 1 });

    await expect(new CodexProfileLifecycleStore({ managerRoot }).listCleanupRequired()).resolves.toEqual([
      { profileId: PROFILE_A, label: "Primary", order: 0 },
      { profileId: PROFILE_B, label: "Secondary", order: 1 },
    ]);
    const lifecycleRoot = path.join(managerRoot, "lifecycle");
    const persisted = await Promise.all((await readdir(lifecycleRoot)).map(async (name) => await readFile(path.join(lifecycleRoot, name), "utf8")));
    expect(persisted.join("\n")).not.toMatch(/codexStateRoot|codexSqliteRoot|operator@example\.com|token/i);

    await store.clearCleanupRequired(PROFILE_A);

    await expect(store.listCleanupRequired()).resolves.toEqual([
      { profileId: PROFILE_B, label: "Secondary", order: 1 },
    ]);
  });
});
