import { access, mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { handleApi } from "../api.js";
import { makeMockRes, makeTempRoot, sameOriginHeaders, writeConfig } from "./helpers.js";

const approvedShadowFields = [
  "clientWorkloadId",
  "requestKind",
  "normalizedModelId",
  "observedAtUnixMs",
  "candidateDecisionId",
  "selectedAccountIds",
  "blockedAccountIds",
  "reasonCategory",
  "latencyBucketMs",
  "errorClass",
].sort();

describe("sanitized shadow observation feed", () => {
  it("exposes only approved per-request metadata through a same-origin read-only API", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const stateDir = path.join(authDir, "cliproxy-dashboard");
    const configPath = await writeConfig(root, authDir);
    await mkdir(logsDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "quota-snapshots.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        keyDerivation: {
          algorithm: "hmac-sha256",
          secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          keyPrefix: "pak_v1",
        },
        snapshots: [],
        credentialBaselines: [],
      })}\n`,
    );
    await writeFile(
      path.join(logsDir, "main.log"),
      [
        "[2026-07-28T00:00:00.000Z] [trace-feed-secret] [info ] [selector.go:500] selected | session=msg:trace-feed-secret auth=codex-shadow-a@example.com.json provider=codex model=gpt-5.4-mini",
        "[2026-07-28T00:00:01.000Z] [trace-feed-secret] [info ] [gin_logger.go:94] 200 | 384.000ms | 127.0.0.1 | POST \"/v1/responses\"",
        "",
      ].join("\n"),
    );

    const req = {
      method: "GET",
      url: "/api/shadow-observation-feed",
      headers: sameOriginHeaders(),
    } as unknown as IncomingMessage;
    const res = makeMockRes();

    await handleApi(req, res.res, { configPath, authDir, proxyUrl: "http://proxy.local", inboundKey: "key" });

    expect(res.getStatus()).toBe(200);
    const body = res.getParsed();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(Object.keys(body[0]).sort()).toEqual(approvedShadowFields);
    expect(body[0]).toMatchObject({
      clientWorkloadId: "loopback-local",
      requestKind: "responses",
      normalizedModelId: "gpt-5.4-mini",
      observedAtUnixMs: Date.parse("2026-07-28T00:00:01.000Z"),
      blockedAccountIds: [],
      reasonCategory: "success",
      latencyBucketMs: 500,
      errorClass: null,
    });
    expect(body[0].candidateDecisionId).toMatch(/^bridge_[A-Za-z0-9_-]{32,}$/);
    expect(body[0].selectedAccountIds).toHaveLength(1);
    expect(body[0].selectedAccountIds[0]).toMatch(/^pak_v1_[A-Za-z0-9_-]{32,}$/);

    const responseText = JSON.stringify(body);
    expect(responseText).not.toContain("raw");
    expect(responseText).not.toContain("trace-feed-secret");
    expect(responseText).not.toContain("codex-shadow-a@example.com.json");
    expect(responseText).not.toContain("/v1/responses");
  });

  it("does not create or repair quota state while deriving sanitized account ids", async () => {
    const root = await makeTempRoot();
    const authDir = path.join(root, "auth");
    const logsDir = path.join(authDir, "logs");
    const configPath = await writeConfig(root, authDir);
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      path.join(logsDir, "main.log"),
      [
        "[2026-07-28T00:01:00.000Z] [trace-feed-missing-state] [info ] [selector.go:500] selected | session=msg:trace-feed-missing-state auth=codex-shadow-b@example.com.json provider=codex model=gpt-5.4",
        "[2026-07-28T00:01:01.000Z] [trace-feed-missing-state] [info ] [gin_logger.go:94] 500 | 1.250s | 10.0.0.7 | POST \"/v1/chat/completions\"",
        "",
      ].join("\n"),
    );

    const req = {
      method: "GET",
      url: "/api/shadow-observation-feed",
      headers: sameOriginHeaders(),
    } as unknown as IncomingMessage;
    const res = makeMockRes();

    await handleApi(req, res.res, { configPath, authDir, proxyUrl: "http://proxy.local", inboundKey: "key" });

    expect(res.getStatus()).toBe(200);
    expect(res.getParsed()).toEqual([
      {
        clientWorkloadId: "non-loopback-or-redacted",
        requestKind: "chat-completions",
        normalizedModelId: "gpt-5.4",
        observedAtUnixMs: Date.parse("2026-07-28T00:01:01.000Z"),
        candidateDecisionId: expect.stringMatching(/^bridge_[A-Za-z0-9_-]{32,}$/),
        selectedAccountIds: [],
        blockedAccountIds: [],
        reasonCategory: "server-error",
        latencyBucketMs: 2_500,
        errorClass: "http-5xx",
      },
    ]);
    await expect(access(path.join(authDir, "cliproxy-dashboard", "quota-snapshots.json"))).rejects.toThrow();
  });
});
