import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

export const TEST_OPERATOR_TOKEN = "test-operator-token";

export function sameOriginHeaders(includeOperatorToken = false): Record<string, string> {
  return {
    host: "127.0.0.1:60948",
    origin: "http://127.0.0.1:60948",
    "sec-fetch-site": "same-origin",
    ...(includeOperatorToken ? { "x-cliproxy-dashboard-token": TEST_OPERATOR_TOKEN } : {}),
  };
}


export async function makeTempRoot() {
  return await mkdtemp(path.join(os.tmpdir(), "cliproxy-dashboard-"));
}

export function accountFixture(
  fileName: string,
  overrides: Partial<{
    priority: number;
    disabled: boolean;
    note: string;
    accountId: string;
  }> = {},
) {
  return {
    fileName,
    path: path.join("/tmp", fileName),
    email: fileName.replace(/^codex-/, "").replace(/\.json(?:\.disabled)?$/, ""),
    priority: overrides.priority ?? 100,
    explicitPriority: overrides.priority !== undefined,
    disabled: overrides.disabled ?? false,
    note: overrides.note ?? "",
    accountId: overrides.accountId ?? "",
    accountIdShort: (overrides.accountId ?? "").slice(0, 8),
    type: "codex",
    plan: "plus",
    expired: "",
    lastRefresh: "",
    raw: {},
  };
}

export function responseLogFixture(
  authFileName: string,
  overrides: Partial<{
    label: string;
    timestamp: string;
  }> = {},
) {
  const label =
    overrides.label ?? authFileName.replace(/^codex-/, "").replace(/\.json(?:\.disabled)?$/, "");
  const timestamp = overrides.timestamp ?? "2026-05-17T11:51:15.447929+07:00";
  return [
    "=== REQUEST INFO ===",
    "Version: 6.9.36",
    "URL: /v1/responses",
    "Method: POST",
    `Timestamp: ${timestamp}`,
    "",
    "=== API REQUEST 1 ===",
    `Auth: provider=codex, auth_id=${authFileName}, label=${label}, type=oauth`,
    "",
    ].join("\n");
}

export async function writeConfig(root: string, authDir: string) {
  const configPath = path.join(root, "config.yaml");
  await writeFile(
    configPath,
    [
      "port: 8317",
      `auth-dir: ${authDir}`,
      "api-keys:",
      "  - key",
      "",
    ].join("\n"),
  );
  return configPath;
}

export async function writeAccountFile(
  authDir: string,
  fileName: string,
  overrides: Record<string, unknown> = {},
) {
  await mkdir(authDir, { recursive: true });
  await writeFile(
    path.join(authDir, fileName),
    `${JSON.stringify(
      {
        email: fileName.replace(/^codex-/, "").replace(/\.json(?:\.disabled)?$/, ""),
        type: "codex",
        account_id: "acct-fixture-123456789",
        access_token: "fixture-access-token",
        refresh_token: "fixture-refresh-token",
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

export async function writeQuotaResponseLog(
  logsDir: string,
  fileName: string,
  authFileName: string,
  options: Partial<{
    timestamp: string;
    primaryUsedPercent: number;
    primaryResetAfterSeconds: number;
    weeklyUsedPercent: number;
    weeklyResetAfterSeconds: number;
  }> = {},
) {
  await mkdir(logsDir, { recursive: true });
  const lines = [
    responseLogFixture(authFileName, {
      timestamp: options.timestamp ?? new Date().toISOString(),
    }),
  ];
  if (options.primaryUsedPercent !== undefined) {
    lines.push(`X-Codex-Primary-Used-Percent: ${options.primaryUsedPercent}`);
  }
  if (options.primaryResetAfterSeconds !== undefined) {
    lines.push(`X-Codex-Primary-Reset-After-Seconds: ${options.primaryResetAfterSeconds}`);
  }
  if (options.weeklyUsedPercent !== undefined) {
    lines.push(`X-Codex-Secondary-Used-Percent: ${options.weeklyUsedPercent}`);
  }
  if (options.weeklyResetAfterSeconds !== undefined) {
    lines.push(`X-Codex-Secondary-Reset-After-Seconds: ${options.weeklyResetAfterSeconds}`);
  }
  await writeFile(path.join(logsDir, fileName), `${lines.join("\n")}\n`);
}

export function stubModelList() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string | URL) => {
      if (String(url).endsWith("/v1/models")) {
        return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
      }
      return new Response("", { status: 404 });
    }),
  );
}

export function makeMockRes() {
  let status = 0;
  let headers: Record<string, string> = {};
  let responseBody = "";
  const res = {
    writeHead: (code: number, hdrs: Record<string, string>) => {
      status = code;
      headers = hdrs;
    },
    end: (body: string) => {
      responseBody = body;
    },
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => status,
    getHeaders: () => headers,
    getBody: () => responseBody,
    getParsed: () => JSON.parse(responseBody),
  };
}
