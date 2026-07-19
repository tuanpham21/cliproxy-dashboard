import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  CodexProfileLifecycleFence,
  CodexProfileLifecycleFenceError,
} from "../codex-profile-lifecycle-fence.js";
import { makeTempRoot } from "./helpers.js";

const PROFILE_A = `profile_${"a".repeat(32)}`;
const PROFILE_B = `profile_${"b".repeat(32)}`;

describe("Codex Login Profile lifecycle fence", () => {
  it("excludes concurrent work for one profile without blocking another profile", async () => {
    const managerRoot = path.join(await makeTempRoot(), "codex-login-profiles");
    const fence = new CodexProfileLifecycleFence({
      managerRoot,
      currentOwner: async () => ({ pid: 101, processStartIdentity: "owner-a" }),
      inspectOwner: async () => "alive",
    });

    const first = await fence.acquire(PROFILE_A, "prepare");
    await expect(fence.acquire(PROFILE_A, "delete")).rejects.toEqual(
      expect.objectContaining<CodexProfileLifecycleFenceError>({ code: "profile-busy" }),
    );
    const other = await fence.acquire(PROFILE_B, "delete");

    await first.release();
    await other.release();
    await expect(fence.acquire(PROFILE_A, "delete")).resolves.toMatchObject({ profileId: PROFILE_A });
  });

  it("recovers a fence whose exact process owner is no longer alive", async () => {
    const managerRoot = path.join(await makeTempRoot(), "codex-login-profiles");
    const stale = new CodexProfileLifecycleFence({
      managerRoot,
      currentOwner: async () => ({ pid: 101, processStartIdentity: "owner-a" }),
      inspectOwner: async () => "alive",
    });
    await stale.acquire(PROFILE_A, "re-login");
    const recovering = new CodexProfileLifecycleFence({
      managerRoot,
      currentOwner: async () => ({ pid: 202, processStartIdentity: "owner-b" }),
      inspectOwner: async (owner) => owner.pid === 101 ? "dead" : "alive",
    });

    const recovered = await recovering.acquire(PROFILE_A, "delete");

    expect(recovered.operation).toBe("delete");
    await recovered.release();
  });
});
