import { chmod, link, mkdir, readdir, readFile, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CodexRuntimeQualifier,
  type CodexRuntimeQualifierDependencies,
} from "../codex-runtime-qualifier.js";
import { makeTempRoot } from "./helpers.js";

const REQUIRED_SCHEMA_FILES = [
  "ClientRequest.json",
  "v2/GetAccountResponse.json",
  "v2/GetAccountRateLimitsResponse.json",
  "v2/ConsumeAccountRateLimitResetCreditParams.json",
  "v2/ConsumeAccountRateLimitResetCreditResponse.json",
] as const;

function schemaFixtures(outcomes = ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]) {
  return {
    "ClientRequest.json": {
        oneOf: [
          {
            type: "object",
            required: ["id", "method", "params"],
            properties: {
              id: { $ref: "#/definitions/RequestId" },
              method: { type: "string", enum: ["account/read"] },
              params: { $ref: "#/definitions/GetAccountParams" },
            },
          },
          {
            type: "object",
            required: ["id", "method"],
            properties: {
              id: { $ref: "#/definitions/RequestId" },
              method: { type: "string", enum: ["account/rateLimits/read"] },
              params: { type: "null" },
            },
          },
          {
            type: "object",
            required: ["id", "method", "params"],
            properties: {
              id: { $ref: "#/definitions/RequestId" },
              method: { type: "string", enum: ["account/rateLimitResetCredit/consume"] },
              params: { $ref: "#/definitions/ConsumeAccountRateLimitResetCreditParams" },
            },
          },
        ],
    },
      "v2/GetAccountResponse.json": {
        required: ["requiresOpenaiAuth"],
        properties: {
          account: { anyOf: [{ $ref: "#/definitions/Account" }, { type: "null" }] },
          requiresOpenaiAuth: { type: "boolean" },
        },
      definitions: {
        Account: {
          oneOf: [
            {
              properties: {
                type: { enum: ["chatgpt"] },
                email: { type: ["string", "null"] },
                planType: { $ref: "#/definitions/PlanType" },
              },
              required: ["type", "email", "planType"],
            },
          ],
        },
      },
    },
      "v2/GetAccountRateLimitsResponse.json": {
        required: ["rateLimits"],
        properties: {
          rateLimits: { allOf: [{ $ref: "#/definitions/RateLimitSnapshot" }] },
          rateLimitResetCredits: { anyOf: [{ $ref: "#/definitions/RateLimitResetCreditsSummary" }, { type: "null" }] },
        },
        definitions: {
          RateLimitSnapshot: {
            properties: {
              primary: { anyOf: [{ $ref: "#/definitions/RateLimitWindow" }, { type: "null" }] },
              secondary: { anyOf: [{ $ref: "#/definitions/RateLimitWindow" }, { type: "null" }] },
            },
          },
          RateLimitWindow: {
          required: ["usedPercent"],
          properties: { usedPercent: {}, windowDurationMins: {}, resetsAt: {} },
        },
          RateLimitResetCreditsSummary: {
            required: ["availableCount"],
            properties: {
              availableCount: {},
              credits: { type: ["array", "null"], items: { $ref: "#/definitions/RateLimitResetCredit" } },
            },
        },
        RateLimitResetCredit: {
          required: ["id", "resetType", "status", "grantedAt"],
          properties: {
            id: {},
            resetType: {},
            status: {},
            grantedAt: {},
            expiresAt: {},
            title: {},
            description: {},
          },
        },
      },
    },
    "v2/ConsumeAccountRateLimitResetCreditParams.json": {
      required: ["idempotencyKey"],
      properties: { idempotencyKey: { type: "string" }, creditId: { type: ["string", "null"] } },
    },
      "v2/ConsumeAccountRateLimitResetCreditResponse.json": {
        required: ["outcome"],
        properties: { outcome: { $ref: "#/definitions/ConsumeAccountRateLimitResetCreditOutcome" } },
        definitions: {
          ConsumeAccountRateLimitResetCreditOutcome: {
            oneOf: outcomes.map((outcome) => ({ type: "string", enum: [outcome] })),
          },
        },
    },
  } as const;
}

async function writeSchemaBundle(outDir: string, fixtures = schemaFixtures()): Promise<void> {
  for (const [relativePath, value] of Object.entries(fixtures)) {
    const filePath = path.join(outDir, relativePath);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value));
  }
}

async function qualifierHarness(
  mutateBundle?: (outDir: string) => Promise<void>,
  dependencyOverrides: Partial<CodexRuntimeQualifierDependencies> = {},
) {
  const root = await makeTempRoot();
  const binDir = path.join(root, "bin with spaces");
  const tempParent = path.join(root, "schema-temp");
  await mkdir(binDir, { recursive: true });
  await mkdir(tempParent, { recursive: true });
  const binaryPath = path.join(binDir, process.platform === "win32" ? "codex.exe" : "codex");
  await writeFile(binaryPath, "#!/bin/sh\n");
  await chmod(binaryPath, 0o700);
  const calls: Array<{ binary: string; args: string[]; timeoutMs: number }> = [];
  const runCommand = vi.fn(async (binary: string, args: string[], timeoutMs: number) => {
    calls.push({ binary, args, timeoutMs });
    if (args[0] === "--version") return { stdout: "codex-cli 0.144.4\n" };
    const outIndex = args.indexOf("--out");
    const outDir = args[outIndex + 1];
    await writeSchemaBundle(outDir);
    await mutateBundle?.(outDir);
    return { stdout: "" };
  });
  const qualifier = new CodexRuntimeQualifier({
    env: { PATH: binDir },
    platform: process.platform,
    tempParent,
    runCommand,
    verifyCodexStateRoot: vi.fn(async () => root),
    windowsSecurity: {
      secureCreatedDirectory: vi.fn(async () => {}),
      verifyPrivatePath: vi.fn(async () => {}),
    },
    ...dependencyOverrides,
  });
  return { qualifier, binaryPath, canonicalBinaryPath: await realpath(binaryPath), calls, root, tempParent, runCommand };
}

describe("Codex runtime qualifier", () => {
  it("fails closed before Codex execution when current-user Codex state privacy cannot be verified", async () => {
    const verifyCodexStateRoot = vi.fn(async () => { throw new Error("shared CODEX_HOME"); });
    const harness = await qualifierHarness(undefined, { verifyCodexStateRoot });

    await expect(harness.qualifier.qualify(harness.binaryPath)).resolves.toMatchObject({ status: "runtime-incompatible" });
    expect(verifyCodexStateRoot).toHaveBeenCalledTimes(1);
    expect(harness.runCommand).not.toHaveBeenCalled();
    await harness.qualifier.close();
  });

  it("rechecks Codex state privacy when validating a cached runtime identity", async () => {
    const verifyCodexStateRoot = vi.fn(async () => "/private/codex-home");
    const harness = await qualifierHarness(undefined, { verifyCodexStateRoot });
    const qualification = await harness.qualifier.qualify(harness.binaryPath);
    if (qualification.status !== "qualified") throw new Error("fixture did not qualify");
    verifyCodexStateRoot.mockRejectedValueOnce(new Error("CODEX_HOME became shared"));

    await expect(harness.qualifier.matchesIdentity(qualification.identity)).resolves.toBe(false);
    await harness.qualifier.close();
  });

  it("rejects a runtime identity when the canonical Codex state root changes", async () => {
    const verifyCodexStateRoot = vi.fn(async () => "/private/codex-home-a");
    const harness = await qualifierHarness(undefined, { verifyCodexStateRoot });
    const qualification = await harness.qualifier.qualify(harness.binaryPath);
    if (qualification.status !== "qualified") throw new Error("fixture did not qualify");
    verifyCodexStateRoot.mockResolvedValue("/private/codex-home-b");

    await expect(harness.qualifier.matchesIdentity(qualification.identity)).resolves.toBe(false);
    await harness.qualifier.close();
  });

  it("qualifies one exact PATH-resolved binary and caches by file identity", async () => {
    const { qualifier, canonicalBinaryPath, calls, tempParent, root } = await qualifierHarness();

    const first = await qualifier.qualify("codex");
    const second = await qualifier.qualify("codex");

    expect(first).toMatchObject({
      status: "qualified",
      version: "codex-cli 0.144.4",
      identity: { canonicalPath: canonicalBinaryPath, codexStateRoot: root },
    });
    expect(first.status === "qualified" ? first.identity.schemaHash : "").toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ binary: canonicalBinaryPath, args: ["--version"], timeoutMs: 15_000 });
    expect(calls[1].binary).toBe(canonicalBinaryPath);
    expect(calls[1].args.slice(0, 3)).toEqual(["app-server", "generate-json-schema", "--out"]);
    expect(calls[1].args).not.toContain("--experimental");
    expect(calls[2]).toEqual({ binary: canonicalBinaryPath, args: ["--version"], timeoutMs: 15_000 });
    expect(await readdir(tempParent)).toEqual([]);
    await qualifier.close();
  });

  it("coalesces concurrent qualification for one binary identity", async () => {
    let releaseVersion!: () => void;
    const versionGate = new Promise<void>((resolve) => {
      releaseVersion = resolve;
    });
    const runCommand = vi.fn(async (_binary: string, args: string[]) => {
      if (args[0] === "--version") {
        await versionGate;
        return { stdout: "codex-cli 0.144.4\n" };
      }
      await writeSchemaBundle(args[args.indexOf("--out") + 1]);
      return { stdout: "" };
    });
    const harness = await qualifierHarness(undefined, { runCommand });
    const firstPromise = harness.qualifier.qualify(harness.binaryPath);
    const secondPromise = harness.qualifier.qualify(harness.binaryPath);
    await vi.waitFor(() => expect(runCommand).toHaveBeenCalledTimes(1));
    releaseVersion();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toMatchObject({ status: "qualified" });
    expect(second).toEqual(first);
    expect(runCommand).toHaveBeenCalledTimes(2);
    await harness.qualifier.close();
  });

  it("invalidates cache when the binary file identity changes", async () => {
    const { qualifier, binaryPath, calls } = await qualifierHarness();
    await qualifier.qualify(binaryPath);
    await writeFile(binaryPath, "#!/bin/sh\n# changed\n");
    await utimes(binaryPath, new Date(), new Date(Date.now() + 1000));

    await qualifier.qualify(binaryPath);
    expect(calls).toHaveLength(4);
    await qualifier.close();
  });

  it("rejects a binary changed during cached version recheck", async () => {
    const harness = await qualifierHarness();
    await expect(harness.qualifier.qualify(harness.binaryPath)).resolves.toMatchObject({ status: "qualified" });
    let mutated = false;
    harness.runCommand.mockImplementation(async (binary: string, args: string[]) => {
      if (args[0] === "--version") {
        if (!mutated) {
          mutated = true;
          await writeFile(binary, "#!/bin/sh\n# replaced during version recheck\n");
        }
        return { stdout: "codex-cli 0.144.4\n" };
      }
      return { stdout: "" };
    });

    await expect(harness.qualifier.qualify(harness.binaryPath)).resolves.toMatchObject({
      status: "runtime-incompatible",
    });
    await harness.qualifier.close();
  });

  it("fails incompatible when the binary changes during qualification", async () => {
    const runCommand = vi.fn(async (binary: string, args: string[]) => {
      if (args[0] === "--version") {
        await writeFile(binary, "#!/bin/sh\n# replaced during qualification\n");
        return { stdout: "codex-cli 0.144.4\n" };
      }
      return { stdout: "" };
    });
    const { qualifier, binaryPath } = await qualifierHarness(undefined, { runCommand });

    await expect(qualifier.qualify(binaryPath)).resolves.toMatchObject({
      status: "runtime-incompatible",
      code: "codex_runtime_incompatible",
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
    await qualifier.close();
  });

  it("fails incompatible for missing schema contract, symlink output, or size overflow", async () => {
    const missing = await qualifierHarness(async (outDir) => {
      await writeSchemaBundle(outDir, schemaFixtures(["reset", "nothingToReset", "noCredit"]));
    });
    await expect(missing.qualifier.qualify(missing.binaryPath)).resolves.toMatchObject({
      status: "runtime-incompatible",
      code: "codex_runtime_incompatible",
    });
    await missing.qualifier.close();

    if (process.platform !== "win32") {
      const symlinked = await qualifierHarness(async (outDir) => {
        const target = path.join(outDir, "target.json");
        await writeFile(target, "{}");
        await symlink(target, path.join(outDir, "unexpected-link.json"));
      });
      await expect(symlinked.qualifier.qualify(symlinked.binaryPath)).resolves.toMatchObject({
        status: "runtime-incompatible",
      });
      await symlinked.qualifier.close();
    }

    const oversized = await qualifierHarness(
      async (outDir) => writeFile(path.join(outDir, REQUIRED_SCHEMA_FILES[0]), "x".repeat(129)),
      { limits: { maxEntries: 4096, maxTotalBytes: 16 * 1024 * 1024, maxInspectedFileBytes: 128 } },
    );
    await expect(oversized.qualifier.qualify(oversized.binaryPath)).resolves.toMatchObject({
      status: "runtime-incompatible",
    });
    await oversized.qualifier.close();
  });

  it("enforces entry, bundle-size, and hard-link caps", async () => {
    const tooManyEntries = await qualifierHarness(
      async (outDir) => {
        await writeFile(path.join(outDir, "extra-a.json"), "{}");
        await writeFile(path.join(outDir, "extra-b.json"), "{}");
      },
      { limits: { maxEntries: 6, maxTotalBytes: 16 * 1024 * 1024, maxInspectedFileBytes: 2 * 1024 * 1024 } },
    );
    await expect(tooManyEntries.qualifier.qualify(tooManyEntries.binaryPath)).resolves.toMatchObject({
      status: "runtime-incompatible",
    });
    await tooManyEntries.qualifier.close();

    const tooLarge = await qualifierHarness(undefined, {
      limits: { maxEntries: 4096, maxTotalBytes: 32, maxInspectedFileBytes: 2 * 1024 * 1024 },
    });
    await expect(tooLarge.qualifier.qualify(tooLarge.binaryPath)).resolves.toMatchObject({
      status: "runtime-incompatible",
    });
    await tooLarge.qualifier.close();

    const hardLinked = await qualifierHarness(async (outDir) => {
      const target = path.join(outDir, "hard-link-target.json");
      await writeFile(target, "{}");
      await link(target, path.join(outDir, "hard-link.json"));
    });
    await expect(hardLinked.qualifier.qualify(hardLinked.binaryPath)).resolves.toMatchObject({
      status: "runtime-incompatible",
    });
    await hardLinked.qualifier.close();
  });

    it("rejects method and outcome enums that live outside exact contract nodes", async () => {
      const decoy = await qualifierHarness(async (outDir) => {
        const clientPath = path.join(outDir, "ClientRequest.json");
        const client = JSON.parse(await readFile(clientPath, "utf8")) as Record<string, unknown>;
        client.oneOf = [{ properties: { method: { enum: ["not-a-supported-method"] } } }];
        client.definitions = {
          DecoyMethodDefinitions: {
            properties: {
              method: { enum: ["account/read", "account/rateLimits/read", "account/rateLimitResetCredit/consume"] },
            },
          },
        };
        await writeFile(clientPath, JSON.stringify(client));

        const responsePath = path.join(outDir, "v2/ConsumeAccountRateLimitResetCreditResponse.json");
        const response = JSON.parse(await readFile(responsePath, "utf8")) as Record<string, unknown>;
        response.properties = { outcome: { $ref: "#/definitions/DecoyOutcome" } };
        response.definitions = {
          DecoyOutcome: {
            oneOf: ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"].map((outcome) => ({ enum: [outcome] })),
          },
        };
        await writeFile(responsePath, JSON.stringify(response));
      });

      await expect(decoy.qualifier.qualify(decoy.binaryPath)).resolves.toMatchObject({
        status: "runtime-incompatible",
      });
      await decoy.qualifier.close();
    });

    it("rejects an outcome property with an unconstrained alternative branch", async () => {
      const unconstrained = await qualifierHarness(async (outDir) => {
        const responsePath = path.join(outDir, "v2/ConsumeAccountRateLimitResetCreditResponse.json");
        const response = JSON.parse(await readFile(responsePath, "utf8")) as {
          properties: Record<string, unknown>;
        };
        response.properties.outcome = {
          anyOf: [
            { $ref: "#/definitions/ConsumeAccountRateLimitResetCreditOutcome" },
            {},
          ],
        };
        await writeFile(responsePath, JSON.stringify(response));
      });

      await expect(unconstrained.qualifier.qualify(unconstrained.binaryPath)).resolves.toMatchObject({
        status: "runtime-incompatible",
      });
      await unconstrained.qualifier.close();
    });

    it("rejects account references with unconstrained alternatives", async () => {
      const unconstrained = await qualifierHarness(async (outDir) => {
        const accountPath = path.join(outDir, "v2/GetAccountResponse.json");
        const account = JSON.parse(await readFile(accountPath, "utf8")) as {
          properties: Record<string, unknown>;
        };
        account.properties.account = {
          anyOf: [
            { $ref: "#/definitions/Account" },
            { type: "null" },
            {},
          ],
        };
        await writeFile(accountPath, JSON.stringify(account));
      });

      await expect(unconstrained.qualifier.qualify(unconstrained.binaryPath)).resolves.toMatchObject({
        status: "runtime-incompatible",
      });
      await unconstrained.qualifier.close();
    });

    it("rejects contradictory sibling keywords on exact schema nodes", async () => {
      const contradictory = await qualifierHarness(async (outDir) => {
        const clientPath = path.join(outDir, "ClientRequest.json");
        const client = JSON.parse(await readFile(clientPath, "utf8")) as {
          oneOf: Array<{ properties: { params: Record<string, unknown> } }>;
        };
        client.oneOf[0].properties.params.not = {};
        await writeFile(clientPath, JSON.stringify(client));

        const accountPath = path.join(outDir, "v2/GetAccountResponse.json");
        const account = JSON.parse(await readFile(accountPath, "utf8")) as {
          properties: { account: Record<string, unknown> };
        };
        account.properties.account.not = {};
        await writeFile(accountPath, JSON.stringify(account));
      });

      await expect(contradictory.qualifier.qualify(contradictory.binaryPath)).resolves.toMatchObject({
        status: "runtime-incompatible",
      });
      await contradictory.qualifier.close();
    });

    it("rejects extra required request and consume fields", async () => {
      const extraRequired = await qualifierHarness(async (outDir) => {
        const clientPath = path.join(outDir, "ClientRequest.json");
        const client = JSON.parse(await readFile(clientPath, "utf8")) as {
          oneOf: Array<{ required: string[] }>;
        };
        client.oneOf[0].required.push("unexpected");
        await writeFile(clientPath, JSON.stringify(client));

        const paramsPath = path.join(outDir, "v2/ConsumeAccountRateLimitResetCreditParams.json");
        const params = JSON.parse(await readFile(paramsPath, "utf8")) as { required: string[] };
        params.required.push("unexpected");
        await writeFile(paramsPath, JSON.stringify(params));
      });

      await expect(extraRequired.qualifier.qualify(extraRequired.binaryPath)).resolves.toMatchObject({
        status: "runtime-incompatible",
      });
      await extraRequired.qualifier.close();
    });

    it("rejects duplicate matching oneOf branches", async () => {
      const duplicate = await qualifierHarness(async (outDir) => {
        const clientPath = path.join(outDir, "ClientRequest.json");
        const client = JSON.parse(await readFile(clientPath, "utf8")) as {
          oneOf: Array<Record<string, unknown>>;
        };
        client.oneOf.push(client.oneOf[0]);
        await writeFile(clientPath, JSON.stringify(client));

        const responsePath = path.join(outDir, "v2/ConsumeAccountRateLimitResetCreditResponse.json");
        const response = JSON.parse(await readFile(responsePath, "utf8")) as {
          definitions: { ConsumeAccountRateLimitResetCreditOutcome: { oneOf: Array<Record<string, unknown>> } };
        };
        const outcomes = response.definitions.ConsumeAccountRateLimitResetCreditOutcome.oneOf;
        outcomes.push(outcomes[0]);
        await writeFile(responsePath, JSON.stringify(response));
      });

      await expect(duplicate.qualifier.qualify(duplicate.binaryPath)).resolves.toMatchObject({
        status: "runtime-incompatible",
      });
      await duplicate.qualifier.close();
    });

    it("fails closed on cleanup failure and retries cleanup during close", async () => {
    let removalAttempts = 0;
    const removeTree = vi.fn(async (root: string) => {
      removalAttempts += 1;
      if (removalAttempts === 1) throw new Error("busy");
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      await actual.rm(root, { recursive: true, force: true });
    });
      const { qualifier, binaryPath } = await qualifierHarness(undefined, { removeTree });

      await expect(qualifier.qualify(binaryPath)).resolves.toMatchObject({ status: "runtime-incompatible" });
      await expect(qualifier.qualify(binaryPath)).resolves.toMatchObject({ status: "runtime-incompatible" });
      expect(removeTree).toHaveBeenCalledTimes(1);
      await qualifier.close();
      expect(removeTree).toHaveBeenCalledTimes(2);
  });
});
