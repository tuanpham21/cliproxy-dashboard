import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createPrivateFilesystemCapability } from "../codex-redemption-private-filesystem.js";
import { makeTempRoot } from "./helpers.js";

describe("reset-redemption private filesystem capability", () => {
  it("proves hard-link no-overwrite, atomic replacement, rename, cleanup, and directory sync", async () => {
    const root = path.join(await makeTempRoot(), "private state with spaces");
    await mkdir(root, { mode: 0o700 });
    const verifyPrivateFile = vi.fn(async () => {});
    const capability = createPrivateFilesystemCapability({ platform: process.platform });

    await capability.qualifyRoot(root, verifyPrivateFile);
    await capability.syncDirectory(root);

    expect(verifyPrivateFile).toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("fails closed when Windows directory durability cannot be proven", async () => {
    const root = path.join(await makeTempRoot(), "windows state");
    await mkdir(root, { mode: 0o700 });
    const syncDirectory = vi.fn(async () => {
      const error = new Error("directory fsync unsupported") as NodeJS.ErrnoException;
      error.code = "EISDIR";
      throw error;
    });
    const capability = createPrivateFilesystemCapability({ platform: "win32", syncDirectory });

    await expect(capability.qualifyRoot(root, async () => {})).rejects.toThrow(
      "Private filesystem capability unavailable.",
    );
    expect(syncDirectory).toHaveBeenCalledTimes(1);
  });

  it("fails closed when hard-link no-overwrite semantics cannot be proven", async () => {
    const root = path.join(await makeTempRoot(), "unsafe state");
    await mkdir(root, { mode: 0o700 });
    const capability = createPrivateFilesystemCapability({
      platform: process.platform,
      linkPath: vi.fn(async () => {}),
    });

    await expect(capability.qualifyRoot(root, async () => {})).rejects.toThrow(
      "Private filesystem capability unavailable.",
    );
  });
});
