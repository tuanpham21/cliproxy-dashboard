import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { handleApi } from "../api.js";
import { TEST_OPERATOR_TOKEN, makeMockRes, sameOriginHeaders } from "./helpers.js";

const profileId = "profile_M8JcV6Qq0YxE2kT4uN7sP9aB";
const row = {
  profileId,
  label: "Primary",
  enabled: true,
  order: 0,
  status: "latest-known" as const,
  observation: {
    account: { email: "operator@example.com", plan: "pro" },
    observedAt: "2026-07-19T04:00:00.000Z",
    usage: { primary: null, secondary: null },
    resetCredits: { availableCount: 2 },
    runtimeVersion: "codex-cli 0.144.4",
    freshness: "latest-known" as const,
  },
};
const listView = {
  profiles: [row],
  summary: {
    total: 1,
    pending: 0,
    fresh: 0,
      latestKnown: 1,
      refreshNeeded: 0,
      stale: 0,
      reLoginRequired: 0,
    disabled: 0,
    identityChanged: 0,
    neverObserved: 0,
    profilesWithResets: 1,
  },
};

function request(method: string, url: string, body = ""): IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(req, {
    method,
    url,
    headers: sameOriginHeaders(true),
    socket: { remoteAddress: "127.0.0.1" },
  }) as unknown as IncomingMessage;
}

function controller() {
  return {
    list: vi.fn(async () => listView),
    refresh: vi.fn(async () => ({ ...row, status: "fresh" as const })),
    updateMetadata: vi.fn(async () => row),
    reorder: vi.fn(async () => listView),
  };
}

const refreshRun = {
  source: "manual" as const,
  outcome: "running" as const,
  startedAt: "2026-07-19T06:00:00.000Z",
  finishedAt: null,
  total: 1,
  completed: 0,
  currentProfileId: profileId,
  profiles: [{ profileId, label: "Primary", status: "refreshing" as const, attempts: 1 }],
};

function refreshController() {
  return {
    refreshAll: vi.fn(async () => ({ ...refreshRun, outcome: "completed" as const, completed: 1 })),
    status: vi.fn(() => refreshRun),
    cancel: vi.fn(async () => ({ ...refreshRun, outcome: "cancelled" as const })),
  };
}

async function call(
  service: ReturnType<typeof controller>,
  method: string,
  url: string,
  body = "",
  refreshService = refreshController(),
) {
  const response = makeMockRes();
  const handled = await handleApi(request(method, url, body), response.res as ServerResponse, {
    host: "127.0.0.1",
      operatorToken: TEST_OPERATOR_TOKEN,
      codexProfileObservationService: service,
      codexProfileRefreshCoordinator: refreshService,
  });
  return { handled, response };
}

describe("Codex Profile Observation API", () => {
  it("lists, updates, reorders, and refreshes opaque profiles without consume capability", async () => {
    const service = controller();

    const listed = await call(service, "GET", "/api/codex/login-profiles");
    expect(listed.response.getStatus()).toBe(200);
    expect(listed.response.getParsed()).toEqual(listView);

    const updated = await call(
      service,
      "PATCH",
      `/api/codex/login-profiles/${profileId}`,
      JSON.stringify({ label: "  Primary work  ", enabled: false }),
    );
    expect(updated.response.getStatus()).toBe(200);
    expect(service.updateMetadata).toHaveBeenCalledWith(profileId, { label: "Primary work", enabled: false });

    const reordered = await call(
      service,
      "PUT",
      "/api/codex/login-profiles/order",
      JSON.stringify({ profileIds: [profileId] }),
    );
    expect(reordered.response.getStatus()).toBe(200);
    expect(service.reorder).toHaveBeenCalledWith([profileId]);

    const refreshed = await call(service, "POST", `/api/codex/login-profiles/${profileId}/refresh`, "{}");
    expect(refreshed.response.getStatus()).toBe(200);
    expect(service.refresh).toHaveBeenCalledWith(profileId);
    expect(JSON.stringify(refreshed.response.getParsed())).not.toMatch(/consume|codexStateRoot|codexSqliteRoot|\/private\//i);
    expect(service).not.toHaveProperty("consume");
  });

  it("rejects path and aggregate-credit fields instead of forwarding them", async () => {
    const service = controller();
    const invalid = await call(
      service,
      "PATCH",
      `/api/codex/login-profiles/${profileId}`,
      JSON.stringify({ codexStateRoot: "/tmp/selected", totalCredits: 99 }),
    );

    expect(invalid.response.getStatus()).toBe(400);
    expect(service.updateMetadata).not.toHaveBeenCalled();
  });

  it("starts, reports, and cancels refresh-all without exposing mutation capability", async () => {
    const service = controller();
    const refreshService = refreshController();

    const started = await call(service, "POST", "/api/codex/login-profiles/refresh-all", "{}", refreshService);
    expect(started.response.getStatus()).toBe(202);
    expect(started.response.getParsed()).toEqual(refreshRun);
    expect(refreshService.refreshAll).toHaveBeenCalledWith("manual");

    const status = await call(service, "GET", "/api/codex/login-profiles/refresh-all", "", refreshService);
    expect(status.response.getStatus()).toBe(200);
    expect(refreshService.status).toHaveBeenCalled();

    const cancelled = await call(service, "DELETE", "/api/codex/login-profiles/refresh-all", "", refreshService);
    expect(cancelled.response.getStatus()).toBe(200);
    expect(cancelled.response.getParsed()).toMatchObject({ outcome: "cancelled" });
    expect(refreshService.cancel).toHaveBeenCalled();
    expect(JSON.stringify([started.response.getParsed(), status.response.getParsed(), cancelled.response.getParsed()]))
      .not.toMatch(/consume|creditId|codexStateRoot|codexSqliteRoot|\/private\//i);
  });
});
