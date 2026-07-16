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

function request(method: string, url: string, body = "", remoteAddress = "127.0.0.1"): IncomingMessage {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  return Object.assign(req, {
    method,
    url,
    headers: sameOriginHeaders(true),
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

  it("prepares from the strict public body on a loopback listener and caller", async () => {
    const service = redemptionService();
    const response = makeMockRes();

    await handleApi(
      request("POST", "/api/codex/reset-redemptions/proposals", JSON.stringify({
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
