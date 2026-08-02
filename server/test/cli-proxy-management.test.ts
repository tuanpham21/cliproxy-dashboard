import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  CLI_PROXY_PRIORITY_CONTRACT_COMMIT,
  CLI_PROXY_PRIORITY_CONTRACT_VERSION,
  createCliProxyManagementWriter,
} from "../cli-proxy-management.js";

const runtimeHeaders = {
  "X-CPA-VERSION": CLI_PROXY_PRIORITY_CONTRACT_VERSION,
  "X-CPA-COMMIT": CLI_PROXY_PRIORITY_CONTRACT_COMMIT,
  "X-CPA-BUILD-DATE": "2026-07-14T15:37:22Z",
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...runtimeHeaders } });
}

async function requestBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown : {};
}

function writeJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json", ...runtimeHeaders });
  res.end(JSON.stringify(body));
}

async function withManagementServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error: unknown) => {
      writeJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe("CLIProxy management priority adapter", () => {
  it("pins the WebSocket-safe production contract build", () => {
    expect(CLI_PROXY_PRIORITY_CONTRACT_COMMIT).toBe("3bbf6da7ad92545c701cdc7bce09ba2ec4db2bcf");
  });

  it("authenticates conditional target patch through an isolated loopback server and verifies identity", async () => {
    await withManagementServer(async (req, res) => {
      expect(req.headers.authorization).toBe("Bearer synthetic-management-key");
      if (req.method === "PATCH") {
        expect(req.url).toBe("/v0/management/auth-files/priority");
        expect(await requestBody(req)).toEqual({ name: "codex-a.json", expected_revision: "revision-1", operation: "set", priority: 101 });
        writeJson(res, { status: "ok", id: "codex-a.json", name: "codex-a.json", revision: "revision-2", priority: { present: true, value: 101 }, persisted: true });
        return;
      }
      expect(req.url).toBe("/v0/management/auth-files");
      writeJson(res, { files: [{ id: "codex-a.json", name: "codex-a.json", priority: 101, priority_present: true, revision: "revision-2", disabled: false, note: "keep" }] });
    }, async (baseUrl) => {
      const writer = createCliProxyManagementWriter({
        baseUrl,
        managementKey: "synthetic-management-key",
          fingerprintResolver: () => "fp-a",
      });
      const result = await writer.setTargetPriority({ fileName: "codex-a.json", proxyAccountKey: "pak-a", priority: 101, expectedFingerprint: "fp-a", expectedRevision: "revision-1" });
      expect(result).toEqual({ priority: 101, explicitPriority: true, fingerprint: "fp-a", revision: "revision-2" });
    });
  });

  it("restores exact absent priority through conditional unset", async () => {
    let revision = "revision-1";
    let priorityPresent = true;
    const patchBodies: unknown[] = [];
    const writer = createCliProxyManagementWriter({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
        fingerprintResolver: () => "fp-a",
      fetchImpl: async (_url, init) => {
        if (init?.method === "PATCH") {
          patchBodies.push(JSON.parse(String(init.body)));
          priorityPresent = false;
          revision = "revision-2";
          return response({ status: "ok", id: "codex-a.json", name: "codex-a.json", revision, priority: { present: false }, persisted: true });
        }
        return response({ files: [{ id: "codex-a.json", name: "codex-a.json", priority: 0, priority_present: priorityPresent, revision }] });
      },
    });

    await writer.restoreBasePriorities({
      "pak-a": { fileName: "codex-a.json", proxyAccountKey: "pak-a", present: false, expectedFingerprint: "fp-a", expectedRevision: "revision-1" },
    });
    expect(patchBodies).toEqual([{ name: "codex-a.json", expected_revision: "revision-1", operation: "unset" }]);
  });

  it("maps an opaque Proxy Account Key to its filename and rejects mismatches before mutation", async () => {
    let revision = "revision-1";
    let priority = 10;
    const patchBodies: unknown[] = [];
    const writer = createCliProxyManagementWriter({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
      fingerprintResolver: () => "fp-a",
      proxyAccountKeyResolver: (fileName) => fileName === "codex-a.json" ? "pak_v1_opaque_a" : "pak_v1_opaque_b",
      fetchImpl: async (_url, init) => {
        if (init?.method === "PATCH") {
          patchBodies.push(JSON.parse(String(init.body)));
          priority = Number((patchBodies.at(-1) as { priority: number }).priority);
          revision = `revision-${patchBodies.length + 1}`;
          return response({
            status: "ok",
            id: "codex-a.json",
            name: "codex-a.json",
            revision,
            priority: { present: true, value: priority },
            persisted: true,
          });
        }
        return response({ files: [{ name: "codex-a.json", priority, priority_present: true, revision }] });
      },
    });

    await writer.setTargetPriority({
      fileName: "codex-a.json",
      proxyAccountKey: "pak_v1_opaque_a",
      priority: 101,
      expectedFingerprint: "fp-a",
      expectedRevision: "revision-1",
    });
    expect(patchBodies).toEqual([{ name: "codex-a.json", expected_revision: "revision-1", operation: "set", priority: 101 }]);

    await expect(writer.setTargetPriority({
      fileName: "codex-a.json",
      proxyAccountKey: "pak_v1_opaque_b",
      priority: 102,
      expectedFingerprint: "fp-a",
      expectedRevision: "revision-2",
    })).rejects.toThrow(/Proxy Account Key.*file name/i);
    expect(patchBodies).toHaveLength(1);
  });

  it("serializes concurrent requests and fails closed on runtime/auth mismatch", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const writer = createCliProxyManagementWriter({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
      fetchImpl: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return response({ files: [{ name: "codex-a.json", priority: 10, priority_present: true, revision: "revision-1", disabled: false, note: "keep" }] });
      },
        fingerprintResolver: () => "fp-a",
    });
    await Promise.all([writer.readAccounts(), writer.readAccounts()]);
    expect(maxInFlight).toBe(1);

    const badRuntime = createCliProxyManagementWriter({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
      fetchImpl: async () => response({ data: [] }, 200),
        expectedVersion: CLI_PROXY_PRIORITY_CONTRACT_VERSION,
        expectedCommit: "wrong",
      fingerprintResolver: () => "fp-a",
    });
    await expect(badRuntime.readAccounts()).rejects.toThrow(/runtime identity/i);

    const badAuth = createCliProxyManagementWriter({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
      fetchImpl: async () => response({ error: "unauthorized" }, 401),
        fingerprintResolver: () => "fp-a",
     });
    await expect(badAuth.readAccounts()).rejects.toThrow(/authentication/i);
  });

  it("filters out non-codex credential files returned by the management API", async () => {
    const writer = createCliProxyManagementWriter({
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
      fetchImpl: async () => response({
        files: [
          { name: "codex-a.json", priority: 10, priority_present: true, revision: "revision-1", disabled: false, note: "keep" },
          { name: "cliproxy-dashboard/quota-snapshots.json", priority: 0, priority_present: false, revision: "revision-1", disabled: false }
        ]
      }),
      fingerprintResolver: () => "fp-a",
    });
    const accounts = await writer.readAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].fileName).toBe("codex-a.json");
  });

  it("fails closed on revision conflict, routing incompatibility, target mismatch, and re-read mismatch", async () => {
    const options = {
      baseUrl: "http://127.0.0.1:8317",
      managementKey: "synthetic-management-key",
        fingerprintResolver: () => "fp-a",
    };
    const input = { fileName: "codex-a.json", proxyAccountKey: "pak-a", priority: 101, expectedFingerprint: "fp-a", expectedRevision: "revision-1" };

    const revisionConflict = createCliProxyManagementWriter({
      ...options,
      fetchImpl: async () => response({ code: "revision_conflict", error: "changed" }, 409),
    });
    await expect(revisionConflict.setTargetPriority(input)).rejects.toThrow(/revision conflict/i);

    const routingIncompatible = createCliProxyManagementWriter({
      ...options,
      fetchImpl: async () => response({ code: "routing_incompatible", error: "websocket" }, 422),
    });
    await expect(routingIncompatible.setTargetPriority(input)).rejects.toThrow(/routing.*incompatible/i);

    const targetMismatch = createCliProxyManagementWriter({
      ...options,
      fetchImpl: async () => response({ status: "ok", id: "codex-b.json", name: "codex-b.json", revision: "revision-2", priority: { present: true, value: 101 }, persisted: true }),
    });
    await expect(targetMismatch.setTargetPriority(input)).rejects.toThrow(/response verification/i);

    let requestCount = 0;
    const rereadMismatch = createCliProxyManagementWriter({
      ...options,
      fetchImpl: async () => {
        requestCount += 1;
        if (requestCount === 1) return response({ status: "ok", id: "codex-a.json", name: "codex-a.json", revision: "revision-2", priority: { present: true, value: 101 }, persisted: true });
        return response({ files: [{ name: "codex-a.json", priority: 10, priority_present: true, revision: "revision-2" }] });
      },
    });
    await expect(rereadMismatch.setTargetPriority(input)).rejects.toThrow(/mutation verification/i);
  });
});
