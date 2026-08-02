import { describe, expect, it } from "vitest";

import type { PublicAccountView, PublicRotationState } from "../../shared/types";
import { renderRotationPanel } from "./rotation";

function account(proxyAccountKey: string): PublicAccountView {
  return {
    proxyAccountKey,
    fileName: `codex-${proxyAccountKey}.json`,
    path: `/synthetic/${proxyAccountKey}.json`,
    email: `${proxyAccountKey}@example.com`,
    priority: 10,
    explicitPriority: true,
    disabled: false,
    note: "",
    accountId: proxyAccountKey,
    accountIdShort: proxyAccountKey.slice(0, 8),
    type: "codex",
    plan: "plus",
    expired: "",
    lastRefresh: "",
    validityStatus: "valid",
    quota: { primary5h: { status: "unknown" }, weekly: { status: "unknown" } },
  };
}

function rotation(overrides: Partial<PublicRotationState> = {}): PublicRotationState {
  return {
    mode: "shadow",
    poolMode: "manual",
    lifecycle: "shadow",
    pool: [{ proxyAccountKey: "pak-a", fileName: "codex-pak-a.json", exclusivityAttested: true, addedAt: "2026-07-16T00:00:00.000Z" }],
    routingTargetKey: "pak-a",
    observedRoutedAccountKey: "pak-b",
    evidenceWatermark: "2026-07-16T00:00:00.000Z",
    lastDecision: { kind: "switch", reason: "Quota Spread reached five percentage points", targetKey: "pak-b", spread: 12 },
    eligibleCount: 2,
    provisionalCount: 1,
    quotaSpread: 12,
    journal: { phase: "verified", routingTargetKey: "pak-b", intendedPriority: 101 },
    manualHold: false,
    restorationVerified: false,
    canActivate: false,
    routingCompatible: true,
    audit: [{ id: "audit-1", at: "2026-07-16T00:00:00.000Z", kind: "decision", message: "synthetic <decision>" }],
    ...overrides,
  };
}

describe("rotation panel", () => {
  it("renders controls, intended versus observed routing, pool intent, journal, and escaped audit", () => {
    const html = renderRotationPanel({ accounts: [account("pak-a"), account("pak-b")], rotation: rotation() });
    expect(html).toContain("Intended Routing Target");
    expect(html).toContain("Observed Routed Account");
    expect(html).toContain("pak-a@example.com");
    expect(html).toContain("pak-b@example.com");
    expect(html).toContain("exclusive intent recorded");
    expect(html).toContain("priority 101");
    expect(html).toContain("synthetic &lt;decision&gt;");
    expect(html).toMatch(/data-rotation-mode="active"[\s\S]*disabled/);
    expect(html).toContain('data-rotation-mode="shadow"');
    expect(html).toContain('aria-pressed="true"');
  });

  it("renders manual pool mode controls", () => {
    const html = renderRotationPanel({
      accounts: [account("pak-a"), account("pak-b")],
      rotation: rotation({ poolMode: "manual" }),
    });
    expect(html).toContain('data-rotation-pool-mode="manual"');
    expect(html).toContain("Add to pool");
    expect(html).toContain("Remove");
  });

  it("renders pause and recovery details without exposing raw HTML", () => {
    const html = renderRotationPanel({
      accounts: [account("pak-a")],
      rotation: rotation({ lifecycle: "recovery-required", pauseReason: "identity-mismatch", pauseMessage: '<img src=x onerror="boom">' }),
    });
    expect(html).toContain("identity-mismatch");
    expect(html).toContain("&lt;img src=x onerror=&quot;boom&quot;&gt;");
    expect(html).not.toContain('<img src=x onerror="boom">');
  });
});
