import { describe, expect, it, vi } from "vitest";

import { CodexProfileOnboardingService } from "../codex-profile-onboarding-service.js";
import type { CodexRuntimeQualifierLike } from "../codex-runtime-qualifier.js";

const profile = {
  id: "profile_M8JcV6Qq0YxE2kT4uN7sP9aB",
  status: "pending" as const,
  runtimeContext: {
    codexStateRoot: "/private/codex-profiles/profile_M8JcV6Qq0YxE2kT4uN7sP9aB",
    codexSqliteRoot: "/private/codex-profiles/profile_M8JcV6Qq0YxE2kT4uN7sP9aB",
  },
};

function setup() {
  const runtimeIdentity = {
    canonicalPath: "/canonical/bin/codex",
    ...profile.runtimeContext,
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4",
    schemaHash: "schema-hash",
  };
  const qualifier: CodexRuntimeQualifierLike = {
    qualify: vi.fn(async () => ({ status: "qualified" as const, version: runtimeIdentity.version, identity: runtimeIdentity })),
    matchesIdentity: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
  const registry = {
    create: vi.fn(async () => profile),
    get: vi.fn(async () => profile),
    confirm: vi.fn(async () => ({ ...profile, status: "confirmed" as const })),
    cancel: vi.fn(async () => {}),
  };
  const loginRunner = {
    start: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
  };
  const gateway = {
    readAccount: vi.fn(async () => ({
      account: { type: "chatgpt" as const, email: "operator@example.com", plan: "pro" as const },
      providerRequiresOpenAiAuth: false,
    })),
    readRateLimits: vi.fn(async () => ({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 25, windowMinutes: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 60, windowMinutes: 10_080, resetsAt: null },
        plan: "pro" as const,
      },
      rateLimitsByLimitId: null,
      resetCredits: { availableCount: 2, credits: null },
    })),
    close: vi.fn(async () => {}),
  };
  const startReadGateway = vi.fn(async () => gateway);
  const service = new CodexProfileOnboardingService({
    registry,
    loginRunner,
    codexBin: "/trusted/bin/codex",
    qualifier,
    startReadGateway,
    now: () => new Date("2026-07-19T04:00:00.000Z"),
  });
  return { service, registry, loginRunner, gateway, qualifier, startReadGateway };
}

describe("Codex Login Profile onboarding service", () => {
  it("keeps a new profile pending until the transient account and plan are explicitly confirmed", async () => {
    const { service, registry, loginRunner, gateway, qualifier, startReadGateway } = setup();

    await expect(service.create()).resolves.toEqual({
      profileId: profile.id,
      status: "login-in-progress",
    });
    expect(loginRunner.start).toHaveBeenCalledWith({
      profileId: profile.id,
      codexBin: "/canonical/bin/codex",
      runtimeContext: profile.runtimeContext,
    });

    const candidate = await service.observe(profile.id);
    expect(candidate).toEqual({
      profileId: profile.id,
      status: "awaiting-confirmation",
      account: { email: "operator@example.com", plan: "pro" },
      observedAt: "2026-07-19T04:00:00.000Z",
      usage: {
        primary: { usedPercent: 25, durationMinutes: 300, resetsAt: "2027-01-15T08:00:00.000Z" },
        secondary: { usedPercent: 60, durationMinutes: 10_080, resetsAt: null },
      },
      resetCredits: { availableCount: 2 },
    });
    expect(loginRunner.wait).toHaveBeenCalledWith(profile.id);
    expect(startReadGateway).toHaveBeenCalledWith({
      codexBin: "/canonical/bin/codex",
      runtimeContext: profile.runtimeContext,
      qualifier,
    });
    expect(gateway.close).toHaveBeenCalledTimes(1);

    await expect(service.confirm(profile.id, {
      confirmed: true,
      email: "other@example.com",
      plan: "pro",
    })).rejects.toMatchObject({ code: "confirmation-mismatch" });
    expect(registry.confirm).not.toHaveBeenCalled();

    await expect(service.confirm(profile.id, {
      confirmed: true,
      email: "operator@example.com",
      plan: "pro",
    })).resolves.toEqual({ ...candidate, status: "confirmed" });
    expect(registry.confirm).toHaveBeenCalledWith(profile.id);
  });

  it("accepts a valid ChatGPT account when the provider also requires OpenAI auth", async () => {
    const { service, gateway } = setup();
    gateway.readAccount.mockResolvedValueOnce({
      account: { type: "chatgpt", email: "operator@example.com", plan: "pro" },
      providerRequiresOpenAiAuth: true,
    });
    await service.create();

    await expect(service.observe(profile.id)).resolves.toMatchObject({
      status: "awaiting-confirmation",
      account: { email: "operator@example.com", plan: "pro" },
    });
  });

  it("qualifies the explicit profile context before canonical login and read sessions", async () => {
    const { service, loginRunner, qualifier, startReadGateway } = setup();

    await service.create();
    await service.observe(profile.id);

    expect(qualifier.qualify).toHaveBeenCalledWith("/trusted/bin/codex", profile.runtimeContext);
    expect(loginRunner.start).toHaveBeenCalledWith({
      profileId: profile.id,
      codexBin: "/canonical/bin/codex",
      runtimeContext: profile.runtimeContext,
    });
    expect(startReadGateway).toHaveBeenCalledWith({
      codexBin: "/canonical/bin/codex",
      runtimeContext: profile.runtimeContext,
      qualifier,
    });
    expect(qualifier.matchesIdentity).toHaveBeenCalled();
  });

  it("retains a pending profile when post-start identity fails and logout cleanup fails", async () => {
    const { service, registry, loginRunner, qualifier } = setup();
    vi.mocked(qualifier.matchesIdentity).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    loginRunner.cancel.mockRejectedValueOnce(new Error("keyring cleanup failed /private/root"));

    await expect(service.create()).rejects.toMatchObject({
      code: "cleanup-failed",
      message: "Codex Login Profile onboarding failed.",
    });
    expect(registry.cancel).not.toHaveBeenCalled();
    await expect(registry.get(profile.id)).resolves.toMatchObject({ id: profile.id, status: "pending" });
  });

  it("retries only the selected pending profile and discards the wrong-account candidate", async () => {
    const { service, loginRunner, registry } = setup();
    await service.create();
    const candidate = await service.observe(profile.id);

    await expect(service.retry(profile.id)).resolves.toEqual({
      profileId: profile.id,
      status: "login-in-progress",
    });

    expect(loginRunner.cancel).toHaveBeenCalledWith({
      profileId: profile.id,
      codexBin: "/canonical/bin/codex",
      runtimeContext: profile.runtimeContext,
    });
    expect(loginRunner.start).toHaveBeenLastCalledWith({
      profileId: profile.id,
      codexBin: "/canonical/bin/codex",
      runtimeContext: profile.runtimeContext,
    });
    expect(registry.cancel).not.toHaveBeenCalled();
    await expect(service.confirm(profile.id, {
      confirmed: true,
      email: candidate.account.email,
      plan: candidate.account.plan,
    })).rejects.toMatchObject({ code: "confirmation-mismatch" });
  });

  it("logs out before removing a cancelled pending profile root", async () => {
    const { service, loginRunner, registry } = setup();
    await service.create();

    await expect(service.cancel(profile.id)).resolves.toEqual({
      profileId: profile.id,
      status: "cancelled",
    });

    expect(loginRunner.cancel).toHaveBeenCalledTimes(1);
    expect(registry.cancel).toHaveBeenCalledWith(profile.id);
    expect(loginRunner.cancel.mock.invocationCallOrder[0]).toBeLessThan(registry.cancel.mock.invocationCallOrder[0] ?? 0);
  });

  it("returns fixed failure codes and closes the read-only gateway without exposing provider output", async () => {
    const { service, gateway } = setup();
    gateway.readAccount.mockRejectedValueOnce(new Error("/private/root token=provider-secret"));
    await service.create();

    const error = await service.observe(profile.id).catch((caught) => caught);

    expect(error).toMatchObject({ code: "read-failed", message: "Codex Login Profile onboarding failed." });
    expect(String(error)).not.toContain("provider-secret");
    expect(gateway.close).toHaveBeenCalledTimes(1);
  });

  it("does not retain a candidate when its read-only app-server cannot close", async () => {
    const { service, gateway } = setup();
    gateway.close.mockRejectedValueOnce(new Error("process close timeout /private/root"));
    await service.create();

    await expect(service.observe(profile.id)).rejects.toMatchObject({ code: "cleanup-failed" });
    await expect(service.confirm(profile.id, {
      confirmed: true,
      email: "operator@example.com",
      plan: "pro",
    })).rejects.toMatchObject({ code: "confirmation-mismatch" });
  });

  it("normalizes impossible provider usage values without crashing or displaying them", async () => {
    const { service, gateway } = setup();
    gateway.readRateLimits.mockResolvedValueOnce({
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: -5, windowMinutes: -1, resetsAt: Number.MAX_SAFE_INTEGER },
        secondary: { usedPercent: 150, windowMinutes: 1.5, resetsAt: -1 },
        plan: "pro",
      },
      rateLimitsByLimitId: null,
      resetCredits: { availableCount: -2, credits: null },
    });
    await service.create();

    await expect(service.observe(profile.id)).resolves.toMatchObject({
      usage: {
        primary: { usedPercent: null, durationMinutes: null, resetsAt: null },
        secondary: { usedPercent: null, durationMinutes: null, resetsAt: null },
      },
      resetCredits: { availableCount: null },
    });
  });

  it("allows cancellation to abort an observation waiting for browser login", async () => {
    const { service, loginRunner, registry } = setup();
    let rejectWait!: (error: Error) => void;
    loginRunner.wait.mockImplementationOnce(async () => await new Promise<void>((_resolve, reject) => {
      rejectWait = reject;
    }));
    loginRunner.cancel.mockImplementationOnce(async () => {
      rejectWait(new Error("login cancelled"));
    });
    await service.create();
    const observation = service.observe(profile.id);
    await vi.waitFor(() => expect(loginRunner.wait).toHaveBeenCalledWith(profile.id));

    await expect(service.cancel(profile.id)).resolves.toEqual({ profileId: profile.id, status: "cancelled" });
    await expect(observation).rejects.toMatchObject({ code: "login-failed" });
    expect(registry.cancel).toHaveBeenCalledWith(profile.id);
  });
});
