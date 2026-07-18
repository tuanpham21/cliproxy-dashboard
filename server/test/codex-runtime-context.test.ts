import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { DefaultCodexRuntimeContextAdapter } from "../codex-runtime-context.js";
import { makeTempRoot } from "./helpers.js";

describe("Codex runtime context", () => {
  it("resolves canonical private Codex and SQLite roots for the default runtime context", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    const codexStateRoot = `${path.join(home, "codex-state")}${path.sep}..${path.sep}codex-state`;
    const codexSqliteRoot = path.join(home, "codex-sqlite");
    await mkdir(codexStateRoot, { recursive: true, mode: 0o700 });
    await mkdir(codexSqliteRoot, { recursive: true, mode: 0o700 });
    const adapter = new DefaultCodexRuntimeContextAdapter({
      env: { CODEX_HOME: codexStateRoot, CODEX_SQLITE_HOME: codexSqliteRoot },
      platform: process.platform,
      homedir: () => home,
      windowsSecurity: {
        secureCreatedDirectory: vi.fn(async () => {}),
        verifyPrivatePath: vi.fn(async () => {}),
      },
    });

    await expect(adapter.resolve()).resolves.toEqual({
      codexStateRoot: await realpath(codexStateRoot),
      codexSqliteRoot: await realpath(codexSqliteRoot),
    });
  });

  it("keeps default runtime SQLite state inside the canonical Codex root when no override exists", async () => {
    const root = await makeTempRoot();
    const home = path.join(root, "home");
    const codexStateRoot = path.join(home, "codex-state");
    await mkdir(codexStateRoot, { recursive: true, mode: 0o700 });
    const adapter = new DefaultCodexRuntimeContextAdapter({
      env: { CODEX_HOME: codexStateRoot },
      platform: process.platform,
      homedir: () => home,
      windowsSecurity: {
        secureCreatedDirectory: vi.fn(async () => {}),
        verifyPrivatePath: vi.fn(async () => {}),
      },
    });
    const canonicalRoot = await realpath(codexStateRoot);

    await expect(adapter.resolve()).resolves.toEqual({
      codexStateRoot: canonicalRoot,
      codexSqliteRoot: canonicalRoot,
    });
  });
});
