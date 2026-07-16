import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { access, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { makeTempRoot } from "./helpers.js";

const require = createRequire(import.meta.url);
const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
const tsxCli = require.resolve("tsx/cli");
const workerScript = fileURLToPath(new URL("./fixtures/codex-redemption-private-state-worker.ts", import.meta.url));

type WorkerResult = { status: "acquired"; proposalId: string } | { status: "rejected"; code: string };

function startWorker(args: string[]): {
  child: ChildProcessWithoutNullStreams;
  result: Promise<WorkerResult>;
  exited: Promise<void>;
} {
  const child = spawn(process.execPath, [tsxCli, workerScript, ...args], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        try {
          resolve(JSON.parse(stdout.slice(0, newline)) as WorkerResult);
        } catch (error) {
          reject(error);
        }
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!stdout.includes("\n")) reject(new Error(`worker exited ${code}: ${stderr}`));
    });
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
    child.once("error", reject);
  });
  return { child, result, exited };
}

describe("reset-redemption cross-process lease", () => {
  it("allows exactly one OS process to publish under a path containing spaces", async () => {
    const parent = await makeTempRoot();
    const root = path.join(parent, "state with spaces", "codex-reset-redemption");
    const bootstrapGate = path.join(parent, "bootstrap worker");
    const bootstrapRelease = path.join(parent, "release bootstrap");
    const bootstrap = startWorker([root, parent, bootstrapGate, bootstrapRelease, "z".repeat(43)]);
    await writeFile(bootstrapGate, "go");
    await expect(bootstrap.result).resolves.toMatchObject({ status: "acquired" });
    await writeFile(bootstrapRelease, "release");
    await bootstrap.exited;

    const gate = path.join(parent, "start workers");
    const release = path.join(parent, "release winner");
    const first = startWorker([root, parent, gate, release, "a".repeat(43)]);
    const second = startWorker([root, parent, gate, release, "b".repeat(43)]);
    try {
      await writeFile(gate, "go");
      const results = await Promise.all([first.result, second.result]);
      expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toEqual([
        { status: "rejected", code: "redemption-proposal-active" },
      ]);

      await writeFile(release, "release");
      await Promise.all([first.exited, second.exited]);
      await expect(access(path.join(root, "active-redemption.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(root)).filter((name) => name !== "account-digest.key")).toEqual([]);
    } finally {
      if (first.child.exitCode === null) first.child.kill("SIGKILL");
      if (second.child.exitCode === null) second.child.kill("SIGKILL");
    }
  }, 20_000);
});
