import {
  CodexAppServerRpcError,
  CodexAppServerSession,
  CodexAppServerTransportError,
} from "./codex-app-server-client.js";

export type CodexKnownPlan =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu";

export type CodexPlan = CodexKnownPlan | "unknown";

export type CodexAppAccount =
  | { type: "apiKey" }
  | { type: "chatgpt"; email: string | null; plan: CodexPlan }
  | { type: "amazonBedrock" };

export type CodexAccountRead = {
  account: CodexAppAccount | null;
  requiresOpenAiAuth: boolean;
};

export type CodexRateLimitWindow = {
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
};

export type CodexRateLimitSnapshot = {
  limitId: string | null;
  limitName: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  plan: CodexPlan | null;
};

export type CodexResetCredit = {
  id: string | null;
  resetType: "codexRateLimits" | "unknown";
  status: "available" | "redeeming" | "redeemed" | "unknown";
  grantedAt: number | null;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
  availability: "available" | "unavailable" | "unsupported" | "malformed";
};

export type CodexRateLimitsRead = {
  rateLimits: CodexRateLimitSnapshot;
  rateLimitsByLimitId: Record<string, CodexRateLimitSnapshot> | null;
  resetCredits: { availableCount: number; credits: CodexResetCredit[] | null } | null;
};

export type CodexAccountGatewayErrorCode =
  | "authentication-required"
  | "invalid-response"
  | "transport-failed"
  | "request-failed";

export type CodexConsumeResetCreditOutcome = "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit";
export type CodexConsumeResetCreditInput = {
  idempotencyKey: string;
  creditId?: string;
  timeoutMs?: number;
  beforeWrite?: () => Promise<void> | void;
  afterWrite?: () => Promise<void> | void;
};

export class CodexAccountGatewayError extends Error {
  readonly code: CodexAccountGatewayErrorCode;
  readonly writeDisposition?: "not-written" | "possibly-written";
  readonly hookErrorCode?: string;

  constructor(code: CodexAccountGatewayErrorCode, writeDisposition?: "not-written" | "possibly-written", hookErrorCode?: string) {
    const message =
      code === "authentication-required"
        ? "Codex authentication is required."
        : code === "invalid-response"
          ? "Codex app-server returned an incompatible response."
          : "Codex app-server request failed.";
    super(message);
    this.name = "CodexAccountGatewayError";
    this.code = code;
    this.writeDisposition = writeDisposition;
    this.hookErrorCode = hookErrorCode;
  }
}

type JsonRecord = Record<string, unknown>;

const KNOWN_PLANS = new Set<CodexKnownPlan>([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "team",
  "self_serve_business_usage_based",
  "business",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
]);

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new CodexAccountGatewayError("invalid-response");
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") invalidResponse();
  return value;
}

function nullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) invalidResponse();
  return value as number;
}

function normalizePlan(value: unknown): CodexPlan {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase();
  if (normalized === "hc") return "enterprise";
  if (normalized === "education") return "edu";
  return KNOWN_PLANS.has(normalized as CodexKnownPlan) ? (normalized as CodexKnownPlan) : "unknown";
}

function normalizeWindow(value: unknown): CodexRateLimitWindow | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) {
    invalidResponse();
  }
  return {
    usedPercent: value.usedPercent,
    windowMinutes: nullableInteger(value.windowDurationMins ?? value.windowMinutes),
    resetsAt: nullableInteger(value.resetsAt),
  };
}

function normalizeSnapshot(value: unknown): CodexRateLimitSnapshot {
  if (!isRecord(value)) invalidResponse();
  return {
    limitId: nullableString(value.limitId),
    limitName: nullableString(value.limitName),
    primary: normalizeWindow(value.primary),
    secondary: normalizeWindow(value.secondary),
    plan: value.planType === null || value.planType === undefined ? null : normalizePlan(value.planType),
  };
}

function normalizeCredit(value: unknown): CodexResetCredit {
  if (!isRecord(value)) {
    return {
      id: null,
      resetType: "unknown",
      status: "unknown",
      grantedAt: null,
      expiresAt: null,
      title: null,
      description: null,
      availability: "malformed",
    };
  }
  let malformed = false;
  const id = typeof value.id === "string" && value.id ? value.id : null;
  if (!id) malformed = true;
  let resetType: CodexResetCredit["resetType"] = "unknown";
  if (value.resetType === "codexRateLimits") resetType = "codexRateLimits";
  else if (typeof value.resetType !== "string") malformed = true;
  let status: CodexResetCredit["status"] = "unknown";
  if (value.status === "available" || value.status === "redeeming" || value.status === "redeemed") {
    status = value.status;
  } else if (typeof value.status !== "string") {
    malformed = true;
  }
  const grantedAt = Number.isSafeInteger(value.grantedAt) ? (value.grantedAt as number) : null;
  if (grantedAt === null) malformed = true;
  let expiresAt: number | null = null;
  if (Number.isSafeInteger(value.expiresAt)) expiresAt = value.expiresAt as number;
  else if (value.expiresAt !== null && value.expiresAt !== undefined) malformed = true;
  const title = typeof value.title === "string" ? value.title : null;
  if (value.title !== null && value.title !== undefined && typeof value.title !== "string") malformed = true;
  const description = typeof value.description === "string" ? value.description : null;
  if (value.description !== null && value.description !== undefined && typeof value.description !== "string") {
    malformed = true;
  }
  const availability = malformed
    ? "malformed"
    : resetType === "unknown" || status === "unknown"
      ? "unsupported"
      : status === "available"
        ? "available"
        : "unavailable";
  return {
    id,
    resetType,
    status,
    grantedAt,
    expiresAt,
    title,
    description,
    availability,
  };
}

function normalizeResetCredits(value: unknown): CodexRateLimitsRead["resetCredits"] {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !Number.isSafeInteger(value.availableCount) || (value.availableCount as number) < 0) {
    invalidResponse();
  }
  if (value.credits !== null && value.credits !== undefined && !Array.isArray(value.credits)) invalidResponse();
  return {
    availableCount: value.availableCount as number,
    credits: Array.isArray(value.credits) ? value.credits.map(normalizeCredit) : null,
  };
}

function normalizeSnapshotMap(value: unknown): Record<string, CodexRateLimitSnapshot> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) invalidResponse();
  return Object.fromEntries(Object.entries(value).map(([key, snapshot]) => [key, normalizeSnapshot(snapshot)]));
}

function mapGatewayError(error: unknown): never {
  if (error instanceof CodexAccountGatewayError) throw error;
  if (error instanceof CodexAppServerRpcError) {
    throw new CodexAccountGatewayError(
      error.category === "authentication-required" ? "authentication-required" : "request-failed",
    );
  }
  if (error instanceof CodexAppServerTransportError) {
    throw new CodexAccountGatewayError("transport-failed", error.writeDisposition, error.hookErrorCode);
  }
  throw new CodexAccountGatewayError("request-failed");
}

export class CodexAccountGateway {
  constructor(private readonly session: CodexAppServerSession) {}

  async readAccount(): Promise<CodexAccountRead> {
    try {
      const value = await this.session.request<unknown>("account/read", { refreshToken: false });
      if (!isRecord(value) || typeof value.requiresOpenaiAuth !== "boolean") invalidResponse();
      if (value.account === null) return { account: null, requiresOpenAiAuth: value.requiresOpenaiAuth };
      if (!isRecord(value.account) || typeof value.account.type !== "string") invalidResponse();
      if (value.account.type === "apiKey") {
        return { account: { type: "apiKey" }, requiresOpenAiAuth: value.requiresOpenaiAuth };
      }
      if (value.account.type === "amazonBedrock") {
        return { account: { type: "amazonBedrock" }, requiresOpenAiAuth: value.requiresOpenaiAuth };
      }
      if (value.account.type !== "chatgpt") invalidResponse();
      const email = nullableString(value.account.email)?.trim() || null;
      return {
        account: { type: "chatgpt", email, plan: normalizePlan(value.account.planType) },
        requiresOpenAiAuth: value.requiresOpenaiAuth,
      };
    } catch (error) {
      mapGatewayError(error);
    }
  }

  async readRateLimits(): Promise<CodexRateLimitsRead> {
    try {
      const value = await this.session.request<unknown>("account/rateLimits/read", {});
      if (!isRecord(value) || !Object.prototype.hasOwnProperty.call(value, "rateLimits")) invalidResponse();
      return {
        rateLimits: normalizeSnapshot(value.rateLimits),
        rateLimitsByLimitId: normalizeSnapshotMap(value.rateLimitsByLimitId),
        resetCredits: normalizeResetCredits(value.rateLimitResetCredits),
      };
    } catch (error) {
      mapGatewayError(error);
    }
  }

  async consumeResetCredit(input: CodexConsumeResetCreditInput): Promise<{ outcome: CodexConsumeResetCreditOutcome }> {
    try {
      const value = await this.session.request<unknown>(
        "account/rateLimitResetCredit/consume",
        input.creditId === undefined
          ? { idempotencyKey: input.idempotencyKey }
          : { idempotencyKey: input.idempotencyKey, creditId: input.creditId },
        {
          timeoutMs: input.timeoutMs ?? 20_000,
          beforeWrite: input.beforeWrite,
          afterWrite: input.afterWrite,
        },
      );
      if (!isRecord(value)) invalidResponse();
      const outcome = value.outcome;
      if (outcome !== "reset" && outcome !== "alreadyRedeemed" && outcome !== "nothingToReset" && outcome !== "noCredit") {
        invalidResponse();
      }
      return { outcome };
    } catch (error) {
      mapGatewayError(error);
    }
  }
}
