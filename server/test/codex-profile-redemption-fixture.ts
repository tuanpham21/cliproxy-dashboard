import type { CodexRateLimitsRead } from "../codex-account-gateway.js";
import type { CodexLoginProfileRecord } from "../codex-login-profile-registry.js";
import type { CodexRuntimeContext } from "../codex-runtime-context.js";
import type { CodexRuntimeIdentity } from "../codex-runtime-qualifier.js";

export const PROFILE_A = `profile_${"a".repeat(32)}`;
export const PROFILE_B = `profile_${"b".repeat(32)}`;

export function profile(id: string, runtimeContext: CodexRuntimeContext): CodexLoginProfileRecord {
  return {
    id,
    status: "confirmed",
    label: id === PROFILE_A ? "Primary" : "Secondary",
    enabled: true,
    order: id === PROFILE_A ? 0 : 1,
    runtimeContext,
  };
}

export function runtimeIdentity(runtimeContext: CodexRuntimeContext): CodexRuntimeIdentity {
  return {
    canonicalPath: "/opt/codex/bin/codex",
    ...runtimeContext,
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4:5",
    schemaHash: "a".repeat(64),
  };
}

export const rateLimits: CodexRateLimitsRead = {
  rateLimits: {
    limitId: null,
    limitName: null,
    primary: { usedPercent: 90, windowMinutes: 300, resetsAt: 1_800_000_000 },
    secondary: null,
    plan: "pro",
  },
  rateLimitsByLimitId: null,
  resetCredits: {
    availableCount: 1,
    credits: [{
      id: "credit-1",
      availability: "available",
      title: "Early reset",
      description: null,
      expiresAt: null,
    }],
  },
};
