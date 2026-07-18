import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { handleApi } from "../api.js";
import { CodexProfileOnboardingError } from "../codex-profile-onboarding-service.js";
import { TEST_OPERATOR_TOKEN, makeMockRes, sameOriginHeaders } from "./helpers.js";

const profileId = "profile_M8JcV6Qq0YxE2kT4uN7sP9aB";
const candidate = {
  profileId,
  status: "awaiting-confirmation" as const,
  account: { email: "operator@example.com", plan: "pro" },
  observedAt: "2026-07-19T04:00:00.000Z",
  usage: { primary: null, secondary: null },
  resetCredits: { availableCount: 1 },
};

function request(method: string, url: string, body = "", remoteAddress = "127.0.0.1"): IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(req, {
    method,
    url,
    headers: sameOriginHeaders(true),
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
}

function controller() {
  return {
    create: vi.fn(async () => ({ profileId, status: "login-in-progress" as const })),
    observe: vi.fn(async () => candidate),
    retry: vi.fn(async () => ({ profileId, status: "login-in-progress" as const })),
    confirm: vi.fn(async () => ({ ...candidate, status: "confirmed" as const })),
    cancel: vi.fn(async () => ({ profileId, status: "cancelled" as const })),
  };
}

async function call(
  service: ReturnType<typeof controller>,
  method: string,
  url: string,
  body = "",
  remoteAddress = "127.0.0.1",
) {
  const response = makeMockRes();
  const handled = await handleApi(request(method, url, body, remoteAddress), response.res as ServerResponse, {
    host: "127.0.0.1",
    operatorToken: TEST_OPERATOR_TOKEN,
    codexProfileOnboardingService: service,
  });
  return { handled, response };
}

describe("Codex Login Profile onboarding API", () => {
  it("creates, observes, retries, confirms, and cancels with opaque profile IDs only", async () => {
    const service = controller();

    const created = await call(service, "POST", "/api/codex/login-profiles");
    expect(created.handled).toBe(true);
    expect(created.response.getStatus()).toBe(201);
    expect(created.response.getParsed()).toEqual({ profileId, status: "login-in-progress" });

    const observed = await call(service, "GET", `/api/codex/login-profiles/${profileId}/onboarding`);
    expect(observed.response.getParsed()).toEqual(candidate);
    expect(JSON.stringify(observed.response.getParsed())).not.toMatch(/codexStateRoot|codexSqliteRoot|\/private\//);

    const retried = await call(service, "POST", `/api/codex/login-profiles/${profileId}/retry`);
    expect(retried.response.getParsed()).toEqual({ profileId, status: "login-in-progress" });

    const confirmation = { confirmed: true, email: "operator@example.com", plan: "pro" };
    const confirmed = await call(
      service,
      "POST",
      `/api/codex/login-profiles/${profileId}/confirm`,
      JSON.stringify(confirmation),
    );
    expect(confirmed.response.getParsed()).toEqual({ ...candidate, status: "confirmed" });
    expect(service.confirm).toHaveBeenCalledWith(profileId, confirmation);

    const cancelled = await call(service, "DELETE", `/api/codex/login-profiles/${profileId}`);
    expect(cancelled.response.getParsed()).toEqual({ profileId, status: "cancelled" });
  });

  it("fails closed off loopback and maps internal failures to fixed browser-safe errors", async () => {
    const service = controller();
    const remote = await call(service, "POST", "/api/codex/login-profiles", "", "10.0.0.8");
    expect(remote.response.getStatus()).toBe(403);
    expect(service.create).not.toHaveBeenCalled();

    service.observe.mockRejectedValueOnce(new CodexProfileOnboardingError("read-failed"));
    const failed = await call(service, "GET", `/api/codex/login-profiles/${profileId}/onboarding`);
    expect(failed.response.getStatus()).toBe(503);
    expect(failed.response.getParsed()).toEqual({
      code: "read-failed",
      error: "Couldn’t check this Codex Login Profile.",
    });
  });

  it("rejects caller-supplied roots instead of forwarding them to onboarding", async () => {
    const service = controller();
    const response = await call(
      service,
      "POST",
      "/api/codex/login-profiles",
      JSON.stringify({ codexStateRoot: "/tmp/attacker-selected-root" }),
    );

    expect(response.response.getStatus()).toBe(400);
    expect(response.response.getParsed()).toEqual({
      code: "invalid-profile-request",
      error: "Codex Login Profile roots are managed by the dashboard.",
    });
    expect(service.create).not.toHaveBeenCalled();
  });
});
