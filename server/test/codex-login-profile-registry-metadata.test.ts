import path from "node:path";
import { describe, expect, it } from "vitest";

import { CodexLoginProfileRegistry } from "../codex-login-profile-registry.js";
import { makeTempRoot } from "./helpers.js";

describe("Codex Login Profile registry metadata", () => {
  it("starts with an empty ordered registry before any profile is created", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");

    await expect(new CodexLoginProfileRegistry({ managerRoot }).list()).resolves.toEqual([]);
  });

  it("persists labels, enabled state, and operator ordering across restart", async () => {
    const managerRoot = path.join(await makeTempRoot(), "dashboard-state", "codex-login-profiles");
    const ids = [
      "profile_A4nM7cX2vL9sP5rK8dB6tH3w",
      "profile_B5nM8cX3vL2sP6rK9dB7tH4w",
    ];
    const registry = new CodexLoginProfileRegistry({
      managerRoot,
      generateId: () => ids.shift() ?? "",
    });
    const first = await registry.create();
    const second = await registry.create();

    await registry.confirm(first.id);
    await registry.confirm(second.id);
    await registry.updateMetadata(second.id, { label: "Work account", enabled: false });
    await registry.reorder([second.id, first.id]);

    const restarted = new CodexLoginProfileRegistry({ managerRoot });
    await expect(restarted.list()).resolves.toMatchObject([
      {
        id: second.id,
        status: "confirmed",
        label: "Work account",
        enabled: false,
        order: 0,
      },
      {
        id: first.id,
        status: "confirmed",
        label: "Codex Login Profile 1",
        enabled: true,
        order: 1,
      },
    ]);
  });
});
