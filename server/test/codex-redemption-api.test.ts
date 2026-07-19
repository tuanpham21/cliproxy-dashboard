import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

import type { CodexRedemptionProposalView } from "../../shared/codex-account-types.js";
import { handleApi } from "../api.js";
import { TEST_OPERATOR_TOKEN, makeMockRes, sameOriginHeaders } from "./helpers.js";

const proposal: CodexRedemptionProposalView = {
  status: "prepared",
  proposalId: "p".repeat(43),
  allowedAction: "cancel",
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-16T12:02:00.000Z",
  account: { email: "operator@example.com", plan: "pro" },
  usage: { primary: null, secondary: null },
  availableCount: 1,
  selection: { mode: "specific", title: "Early reset", description: null, expiresAt: null },
};

function request(
  method: string,
  url: string,
  body = "",
  remoteAddress = "127.0.0.1",
  headers = sameOriginHeaders(true),
): IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(req, {
    method,
    url,
    headers,
    socket: { remoteAddress },
  }) as unknown as IncomingMessage;
}

function redemptionService() {
  return {
    prepare: vi.fn(async () => proposal),
    state: vi.fn(async () => ({ status: "not-found" as const })),
    cancel: vi.fn(async (proposalId: string) => ({ status: "cancelled" as const, proposalId })),
    consume: vi.fn(async () => ({ status: "not-found" as const })),
    initializeRecovery: vi.fn(async () => {}),
    currentState: vi.fn(async () => ({ status: "not-found" as const })),
    close: vi.fn(async () => {}),
  };
}

describe("Codex reset-redemption API", () => {
  it("discovers current recovery state through a side-effect-free loopback GET", async () => {
    const service = redemptionService();
    service.currentState.mockResolvedValue({
      status: "ambiguous",
      proposalId: proposal.proposalId,
      allowedAction: "retry-same",
      selectionMode: "specific",
      dispatchAt: "2026-07-16T12:00:01.000Z",
    });
    const response = makeMockRes();

    await handleApi(
      request("GET", "/api/codex/reset-redemptions/current"),
      response.res as ServerResponse,
      {
        host: "127.0.0.1",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      },
    );

    expect(response.getStatus()).toBe(200);
    expect(response.getParsed()).toMatchObject({ status: "ambiguous", allowedAction: "retry-same" });
    expect(service.currentState).toHaveBeenCalledTimes(1);
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.consume).not.toHaveBeenCalled();
  });

  it("preserves unavailable private-state diagnostics through the current-state endpoint", async () => {
    const service = redemptionService();
    service.currentState.mockResolvedValue({
      status: "unavailable",
      code: "redemption-private-state-unavailable",
      message: "Private reset redemption state is unavailable on this host.",
    });
    const response = makeMockRes();

    await handleApi(
      request("GET", "/api/codex/reset-redemptions/current"),
      response.res as ServerResponse,
      { host: "127.0.0.1", operatorToken: TEST_OPERATOR_TOKEN, codexRedemptionService: service },
    );

    expect(response.getStatus()).toBe(200);
    expect(response.getParsed()).toEqual({
      status: "unavailable",
      code: "redemption-private-state-unavailable",
      message: "Private reset redemption state is unavailable on this host.",
    });
  });

  it("prepares from the strict public body on a loopback listener and caller", async () => {
    const service = redemptionService();
    const response = makeMockRes();

    await handleApi(
      request("POST", "/api/codex/reset-redemptions/proposals", JSON.stringify({
        profileId: `profile_${"a".repeat(32)}`,
        creditId: "credit-1",
        singleWorkspaceAttested: true,
      })),
      response.res as ServerResponse,
      {
        host: "127.0.0.1",
        codexBin: "/opt/codex/bin/codex",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      },
    );

    expect(response.getStatus()).toBe(201);
    expect(response.getParsed()).toEqual(proposal);
    expect(service.prepare).toHaveBeenCalledWith("/opt/codex/bin/codex", {
      profileId: `profile_${"a".repeat(32)}`,
      creditId: "credit-1",
      singleWorkspaceAttested: true,
    });
  });

  it("polls one opaque proposal through the read-only state seam", async () => {
    const service = redemptionService();
    service.state.mockResolvedValue({
      status: "prepared",
      proposalId: proposal.proposalId,
      allowedAction: "cancel",
      createdAt: proposal.createdAt,
      expiresAt: proposal.expiresAt,
      selectionMode: "specific",
    });
    const response = makeMockRes();

    await handleApi(
      request("GET", `/api/codex/reset-redemptions/${proposal.proposalId}`),
      response.res as ServerResponse,
      {
        host: "127.0.0.1",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      },
    );

    expect(response.getStatus()).toBe(200);
    expect(response.getParsed()).toMatchObject({ status: "prepared", allowedAction: "cancel" });
    expect(service.state).toHaveBeenCalledWith(proposal.proposalId);
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it("cancels one prepared proposal through the explicit DELETE route", async () => {
    const service = redemptionService();
    const response = makeMockRes();

    await handleApi(
      request("DELETE", `/api/codex/reset-redemptions/proposals/${proposal.proposalId}`),
      response.res as ServerResponse,
      {
        host: "127.0.0.1",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      },
    );

    expect(response.getStatus()).toBe(200);
    expect(response.getParsed()).toEqual({ status: "cancelled", proposalId: proposal.proposalId });
    expect(service.cancel).toHaveBeenCalledWith(proposal.proposalId);
  });

  it("consumes one prepared proposal through the loopback-only empty-body route", async () => {
    const service = redemptionService();
    service.consume.mockResolvedValue({
      status: "terminal",
      proposalId: proposal.proposalId,
      allowedAction: "none",
      selectionMode: "specific",
      outcome: "reset",
      reconciliation: "reconciled",
      message: "Usage limits reset. Checking current usage…",
      auditEventId: "a".repeat(43),
      createdAt: "2026-07-16T12:00:01.000Z",
      expiresAt: "2026-07-16T12:10:01.000Z",
    });
    const response = makeMockRes();

    await handleApi(
      request("POST", `/api/codex/reset-redemptions/proposals/${proposal.proposalId}/consume`),
      response.res as ServerResponse,
      {
        host: "127.0.0.1",
        codexBin: "codex",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      },
    );

    expect(response.getStatus()).toBe(200);
    expect(response.getParsed()).toMatchObject({ status: "terminal", outcome: "reset" });
    expect(service.consume).toHaveBeenCalledWith(proposal.proposalId, "codex");
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it("rejects non-empty or non-loopback consume requests before service mutation", async () => {
    const service = redemptionService();
    for (const req of [
      request("POST", `/api/codex/reset-redemptions/proposals/${proposal.proposalId}/consume`, "{}"),
      request("POST", `/api/codex/reset-redemptions/proposals/${proposal.proposalId}/consume`, "", "10.0.0.4"),
    ]) {
      const response = makeMockRes();
      await handleApi(req, response.res as ServerResponse, {
        host: "127.0.0.1",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      });
      expect([400, 403]).toContain(response.getStatus());
    }
    expect(service.consume).not.toHaveBeenCalled();
  });

  it("enforces listener, IPv4/IPv6 caller, Origin, Host, and operator-token boundaries", async () => {
    const service = redemptionService();
    const validBody = JSON.stringify({
      profileId: `profile_${"a".repeat(32)}`,
      singleWorkspaceAttested: true,
      creditId: "credit-1",
    });
    const invalidCases = [
      {
        req: request("POST", "/api/codex/reset-redemptions/proposals", validBody, "127.0.0.1", sameOriginHeaders(false)),
        host: "127.0.0.1",
      },
      {
        req: request("POST", "/api/codex/reset-redemptions/proposals", validBody, "127.0.0.1", {
          ...sameOriginHeaders(true),
          "x-cliproxy-dashboard-token": "wrong-token",
        }),
        host: "127.0.0.1",
      },
      {
        req: request("POST", "/api/codex/reset-redemptions/proposals", validBody, "127.0.0.1", {
          ...sameOriginHeaders(true),
          origin: "http://attacker.invalid",
        }),
        host: "127.0.0.1",
      },
      {
        req: request("POST", "/api/codex/reset-redemptions/proposals", validBody),
        host: "0.0.0.0",
      },
      {
        req: request("POST", "/api/codex/reset-redemptions/proposals", validBody, "127.0.0.1", {
          host: "attacker.invalid:60948",
          origin: "http://attacker.invalid:60948",
          "sec-fetch-site": "same-origin",
          "x-cliproxy-dashboard-token": TEST_OPERATOR_TOKEN,
        }),
        host: "127.0.0.1",
      },
    ];
    for (const testCase of invalidCases) {
      const response = makeMockRes();
      await handleApi(testCase.req, response.res as ServerResponse, {
        host: testCase.host,
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      });
      expect(response.getStatus()).toBe(403);
    }
    expect(service.prepare).not.toHaveBeenCalled();

    const ipv6Response = makeMockRes();
    await handleApi(
      request("POST", "/api/codex/reset-redemptions/proposals", validBody, "::1", {
        host: "[::1]:60948",
        origin: "http://[::1]:60948",
        "sec-fetch-site": "same-origin",
        "x-cliproxy-dashboard-token": TEST_OPERATOR_TOKEN,
      }),
      ipv6Response.res as ServerResponse,
      { host: "::1", operatorToken: TEST_OPERATOR_TOKEN, codexRedemptionService: service },
    );
    expect(ipv6Response.getStatus()).toBe(201);
    expect(service.prepare).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized, cross-boundary, and client-supplied server fields before service work", async () => {
    const service = redemptionService();
    const cases = [
      request("POST", "/api/codex/reset-redemptions/proposals", JSON.stringify({
        singleWorkspaceAttested: true,
        email: "client@example.com",
      })),
      request("POST", "/api/codex/reset-redemptions/proposals", JSON.stringify({
        singleWorkspaceAttested: false,
      })),
      request("POST", "/api/codex/reset-redemptions/proposals", JSON.stringify({
        singleWorkspaceAttested: true,
      })),
      request("POST", "/api/codex/reset-redemptions/proposals", JSON.stringify({
        profileId: "/private/codex/profile-root",
        singleWorkspaceAttested: true,
      })),
      request("POST", "/api/codex/reset-redemptions/proposals", `{"singleWorkspaceAttested":true,"creditId":"${"x".repeat(2_100)}"}`),
      request("POST", "/api/codex/reset-redemptions/proposals", JSON.stringify({
        singleWorkspaceAttested: true,
      }), "10.0.0.8"),
    ];

    for (const req of cases) {
      const response = makeMockRes();
      await handleApi(req, response.res as ServerResponse, {
        host: "127.0.0.1",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      });
      expect([400, 403]).toContain(response.getStatus());
      expect(JSON.stringify(response.getParsed())).not.toContain("client@example.com");
    }
    expect(service.prepare).not.toHaveBeenCalled();
  });

  it("rejects a cancellation body instead of accepting client state fields", async () => {
    const service = redemptionService();
    const response = makeMockRes();

    await handleApi(
      request(
        "DELETE",
        `/api/codex/reset-redemptions/proposals/${proposal.proposalId}`,
        JSON.stringify({ ownerNonce: "client-value" }),
      ),
      response.res as ServerResponse,
      {
        host: "127.0.0.1",
        operatorToken: TEST_OPERATOR_TOKEN,
        codexRedemptionService: service,
      },
    );

    expect(response.getStatus()).toBe(400);
    expect(response.getParsed()).toEqual({
      code: "redemption-invalid-request",
      error: "Reset redemption request is invalid.",
    });
    expect(service.cancel).not.toHaveBeenCalled();
  });
});
