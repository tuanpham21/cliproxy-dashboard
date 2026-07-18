import type {
  CodexAccountResetCredit,
  CodexAccountUsageView,
  CodexAccountUsageWindow,
} from "../shared/types.js";
import {
  CodexAccountGateway,
  CodexAccountGatewayError,
  type CodexRateLimitWindow,
  type CodexResetCredit,
} from "./codex-account-gateway.js";
import { codexSecondsToIso, normalizeCodexAvailableCount, normalizeCodexUsageWindow } from "./codex-account-normalization.js";
import { startCodexAppServerSession, type CodexAppServerSession } from "./codex-app-server-client.js";
import { runtimeContextFromIdentity, type CodexRuntimeContext } from "./codex-runtime-context.js";
import type { CodexRuntimeQualification, CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";

export interface CodexAccountUsageReader {
  read(codexBin: string): Promise<CodexAccountUsageView>;
}

export type CodexAppAccountUsageServiceDependencies = {
  qualifier: CodexRuntimeQualifierLike;
  startSession?: (options: { codexBin: string; runtimeContext: CodexRuntimeContext }) => Promise<CodexAppServerSession>;
  now?: () => Date;
};

function emptyView(
  state: CodexAccountUsageView["state"],
  errorCode: CodexAccountUsageView["errorCode"],
  message: string,
  runtime: CodexAccountUsageView["runtime"],
): CodexAccountUsageView {
  return {
    state,
    errorCode,
    message,
    runtime,
    account: null,
    observedAt: null,
    usage: null,
    resetCredits: null,
  };
}

function runtimeView(qualification: CodexRuntimeQualification): CodexAccountUsageView["runtime"] {
  if (qualification.status === "qualified") {
    return { status: "qualified", version: qualification.version };
  }
  return {
    status: qualification.status === "runtime-unavailable" ? "unavailable" : "incompatible",
    version: null,
  };
}

function boundedText(value: string | null, maxBytes: number): string | null {
  if (value === null) return null;
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const bytes = Buffer.from(value, "utf8");
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function resetCredit(credit: CodexResetCredit): CodexAccountResetCredit {
  return {
    id: credit.id,
    availability: credit.availability,
    title: boundedText(credit.title, 256),
    description: boundedText(credit.description, 2048),
    grantedAt: codexSecondsToIso(credit.grantedAt),
    expiresAt: codexSecondsToIso(credit.expiresAt),
  };
}

export class CodexAppAccountUsageService implements CodexAccountUsageReader {
  private readonly qualifier: CodexRuntimeQualifierLike;
  private readonly startSession: (options: {
    codexBin: string;
    runtimeContext: CodexRuntimeContext;
  }) => Promise<CodexAppServerSession>;
  private readonly now: () => Date;

  constructor(dependencies: CodexAppAccountUsageServiceDependencies) {
    this.qualifier = dependencies.qualifier;
    this.startSession = dependencies.startSession ?? startCodexAppServerSession;
    this.now = dependencies.now ?? (() => new Date());
  }

  async read(codexBin: string): Promise<CodexAccountUsageView> {
    const qualification = await this.qualifier.qualify(codexBin);
    const runtime = runtimeView(qualification);
    if (qualification.status === "runtime-unavailable") {
      return emptyView("runtime-unavailable", qualification.code, qualification.message, runtime);
    }
    if (qualification.status === "runtime-incompatible") {
      return emptyView("runtime-incompatible", qualification.code, qualification.message, runtime);
    }
    if (!(await this.qualifier.matchesIdentity(qualification.identity))) {
      return emptyView(
        "runtime-incompatible",
        "codex_runtime_incompatible",
        "Codex runtime or local state does not meet the required safety contract.",
        { status: "incompatible", version: null },
      );
    }

      let session: CodexAppServerSession | null = null;
      try {
        session = await this.startSession({
          codexBin: qualification.identity.canonicalPath,
          runtimeContext: runtimeContextFromIdentity(qualification.identity),
        });
      if (!(await this.qualifier.matchesIdentity(qualification.identity))) {
        return emptyView(
          "runtime-incompatible",
          "codex_runtime_incompatible",
          "Codex runtime or local state does not meet the required safety contract.",
          { status: "incompatible", version: null },
        );
      }
      const gateway = new CodexAccountGateway(session);
      const accountRead = await gateway.readAccount();
      if (accountRead.account === null) {
        return emptyView(
          "signed-out",
          "codex_auth_required",
          "Sign in to Codex with ChatGPT, then refresh.",
          runtime,
        );
      }

      const rateLimits = await gateway.readRateLimits();
      const account =
        accountRead.account.type === "chatgpt"
          ? { email: accountRead.account.email, plan: accountRead.account.plan }
          : { email: null, plan: null };
      const observedAt = this.now().toISOString();
      const credits = (rateLimits.resetCredits?.credits ?? []).map(resetCredit);
      credits.sort((left, right) => {
        const leftAvailable = left.availability === "available";
        const rightAvailable = right.availability === "available";
        if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;
        if (!leftAvailable) return 0;
        if (left.expiresAt === null && right.expiresAt === null) return (left.id ?? "").localeCompare(right.id ?? "");
        if (left.expiresAt === null) return 1;
        if (right.expiresAt === null) return -1;
        return left.expiresAt.localeCompare(right.expiresAt) || (left.id ?? "").localeCompare(right.id ?? "");
      });
      credits.splice(128);
        const availableCount = normalizeCodexAvailableCount(rateLimits.resetCredits?.availableCount) ?? 0;
      const selectionMode =
        availableCount <= 0
          ? "none"
          : credits.some((credit) => credit.availability === "available" && Boolean(credit.id))
            ? "detailed"
            : "generic";
      const common = {
        runtime,
        account,
        observedAt,
        usage: {
            primary: normalizeCodexUsageWindow(rateLimits.rateLimits.primary),
            secondary: normalizeCodexUsageWindow(rateLimits.rateLimits.secondary),
        },
        resetCredits: { availableCount, selectionMode, credits },
      } as const;

      if (accountRead.account.type !== "chatgpt" || !account.email || account.plan === "unknown") {
        return {
          state: "identity-incomplete",
          errorCode: "codex_identity_incomplete",
          message: "Codex did not provide an email and known plan. Redemption is unavailable.",
          ...common,
        };
      }
      if (availableCount <= 0) {
        return {
          state: "usage-ready-no-resets",
          errorCode: null,
          message: "No earned usage limit resets available.",
          ...common,
        };
      }
      return {
        state: "usage-ready-resets-available",
        errorCode: null,
        message: `${availableCount} earned usage limit reset${availableCount === 1 ? " is" : "s are"} available.`,
        ...common,
      };
      } catch (error) {
        if (error instanceof CodexAccountGatewayError && error.code === "authentication-required") {
          return emptyView(
            "signed-out",
            "codex_auth_required",
            "Sign in to Codex with ChatGPT, then refresh.",
            runtime,
          );
        }
        return emptyView("read-failed", "codex_read_failed", "Couldn’t load Codex app usage.", runtime);
    } finally {
      await session?.close();
    }
  }
}
