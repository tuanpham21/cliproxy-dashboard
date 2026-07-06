import { mkdir, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { handleApi } from "../api.js";
import { serveFrontend } from "../static.js";
import { TEST_OPERATOR_TOKEN, makeMockRes, makeTempRoot, sameOriginHeaders } from "./helpers.js";

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, url, headers } as unknown as IncomingMessage;
}

describe("cliproxy dashboard runtime bootstrap and static frontend", () => {
  it("serves the Vite shell without baking in the runtime operator token", async () => {
    const root = await makeTempRoot();
    const frontendDistDir = path.join(root, "frontend");
    await mkdir(path.join(frontendDistDir, "assets"), { recursive: true });
    await writeFile(
      path.join(frontendDistDir, "index.html"),
      '<html><head><meta name="cliproxy-dashboard-token" content="__CLIPROXY_OPERATOR_TOKEN__"></head><body></body></html>',
    );

    const res = makeMockRes();
    const handled = await serveFrontend(mockReq("GET", "/"), res.res, {
      operatorToken: TEST_OPERATOR_TOKEN,
      frontendDistDir,
    });

    expect(handled).toBe(true);
    expect(res.getStatus()).toBe(200);
    expect(res.getBody()).not.toContain(TEST_OPERATOR_TOKEN);
    expect(res.getBody()).toContain("__CLIPROXY_OPERATOR_TOKEN__");
    expect(res.getHeaders()["Content-Security-Policy"]).toContain("script-src 'self'");
    expect(res.getHeaders()["Content-Security-Policy"]).not.toContain("'unsafe-inline'");
    expect(res.getHeaders()["Cache-Control"]).toBe("no-store");
  });

  it("serves only scoped assets and does not catch API paths", async () => {
    const root = await makeTempRoot();
    const frontendDistDir = path.join(root, "frontend");
    await mkdir(path.join(frontendDistDir, "assets"), { recursive: true });
    await writeFile(path.join(frontendDistDir, "assets", "dashboard.js"), "console.log('ok');\n");

    const assetRes = makeMockRes();
    expect(
      await serveFrontend(mockReq("GET", "/assets/dashboard.js"), assetRes.res, {
        operatorToken: TEST_OPERATOR_TOKEN,
        frontendDistDir,
      }),
    ).toBe(true);
    expect(assetRes.getStatus()).toBe(200);
    expect(assetRes.getHeaders()["Content-Type"]).toContain("text/javascript");

    await writeFile(path.join(frontendDistDir, "assets", "dashboard.woff2"), "font");
    const fontRes = makeMockRes();
    expect(
      await serveFrontend(mockReq("GET", "/assets/dashboard.woff2"), fontRes.res, {
        operatorToken: TEST_OPERATOR_TOKEN,
        frontendDistDir,
      }),
    ).toBe(true);
    expect(fontRes.getStatus()).toBe(200);
    expect(fontRes.getHeaders()["Content-Type"]).toBe("font/woff2");

    const traversalRes = makeMockRes();
    expect(
      await serveFrontend(mockReq("GET", "/assets/..%2Fpackage.json"), traversalRes.res, {
        operatorToken: TEST_OPERATOR_TOKEN,
        frontendDistDir,
      }),
    ).toBe(true);
    expect(traversalRes.getStatus()).toBe(404);

    const apiRes = makeMockRes();
    expect(
      await serveFrontend(mockReq("GET", "/api/not-real"), apiRes.res, {
        operatorToken: TEST_OPERATOR_TOKEN,
        frontendDistDir,
      }),
    ).toBe(false);
  });

  it("keeps bootstrap same-origin-only and representative API routes token-protected", async () => {
    const bootstrapRes = makeMockRes();
    await handleApi(
      mockReq("GET", "/api/bootstrap", sameOriginHeaders()),
      bootstrapRes.res,
      { operatorToken: TEST_OPERATOR_TOKEN },
    );
    expect(bootstrapRes.getStatus()).toBe(200);
    expect(bootstrapRes.getParsed()).toEqual({ operatorToken: TEST_OPERATOR_TOKEN });

    const configuredHostRes = makeMockRes();
    await handleApi(
      mockReq("GET", "/api/bootstrap", {
        host: "dashboard.local:60949",
        origin: "http://dashboard.local:60949",
        "sec-fetch-site": "same-origin",
      }),
      configuredHostRes.res,
      { host: "dashboard.local", operatorToken: TEST_OPERATOR_TOKEN },
    );
    expect(configuredHostRes.getStatus()).toBe(200);

    const crossOriginRes = makeMockRes();
    await handleApi(
      mockReq("GET", "/api/bootstrap", {
        host: "127.0.0.1:60948",
        origin: "http://evil.example",
      }),
      crossOriginRes.res,
      { operatorToken: TEST_OPERATOR_TOKEN },
    );
    expect(crossOriginRes.getStatus()).toBe(403);

    const reboundRes = makeMockRes();
    await handleApi(
      mockReq("GET", "/api/bootstrap", {
        host: "dashboard.attacker.test:60949",
        origin: "http://dashboard.attacker.test:60949",
        "sec-fetch-site": "same-origin",
      }),
      reboundRes.res,
      { operatorToken: TEST_OPERATOR_TOKEN },
    );
    expect(reboundRes.getStatus()).toBe(403);

    const missingTokenRes = makeMockRes();
    await handleApi(
      mockReq("POST", "/api/routing", sameOriginHeaders()),
      missingTokenRes.res,
      { operatorToken: TEST_OPERATOR_TOKEN },
    );
    expect(missingTokenRes.getStatus()).toBe(403);
  });
});
