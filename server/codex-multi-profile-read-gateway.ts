import {
  startCodexAppServerSession,
  type CodexAppServerSession,
  type CodexAppServerSessionOptions,
} from "./codex-app-server-client.js";
import {
  CodexAccountGateway,
  type CodexAccountRead,
  type CodexRateLimitsRead,
} from "./codex-account-gateway.js";
import { runtimeContextFromIdentity } from "./codex-runtime-context.js";
import type { CodexRuntimeQualifierLike } from "./codex-runtime-qualifier.js";

export type CodexMultiProfileReadGatewayStartOptions = Omit<
  CodexAppServerSessionOptions,
  "codexBin" | "runtimeContext"
> & {
  codexBin: string;
  runtimeContext: CodexAppServerSessionOptions["runtimeContext"];
  qualifier: CodexRuntimeQualifierLike;
};

export interface CodexMultiProfileReadGatewayLike {
  readAccount(): Promise<CodexAccountRead>;
  readRateLimits(): Promise<CodexRateLimitsRead>;
  close(): Promise<void>;
}

export class CodexMultiProfileReadGatewayError extends Error {
  constructor() {
    super("Codex multi-profile read runtime is unavailable.");
    this.name = "CodexMultiProfileReadGatewayError";
  }
}

export class CodexMultiProfileReadGateway implements CodexMultiProfileReadGatewayLike {
  private constructor(
    private readonly session: CodexAppServerSession,
    private readonly accountGateway: CodexAccountGateway,
  ) {}

  static async start(options: CodexMultiProfileReadGatewayStartOptions): Promise<CodexMultiProfileReadGateway> {
    let qualification;
    try {
      qualification = await options.qualifier.qualify(options.codexBin, options.runtimeContext);
      if (qualification.status !== "qualified" || !(await options.qualifier.matchesIdentity(qualification.identity))) {
        throw new CodexMultiProfileReadGatewayError();
      }
    } catch {
      throw new CodexMultiProfileReadGatewayError();
    }
    const { qualifier, codexBin: _codexBin, runtimeContext: _runtimeContext, ...sessionOptions } = options;
    const session = await startCodexAppServerSession({
      ...sessionOptions,
      codexBin: qualification.identity.canonicalPath,
      runtimeContext: runtimeContextFromIdentity(qualification.identity),
    });
    let identityMatches = false;
    try {
      identityMatches = await qualifier.matchesIdentity(qualification.identity);
    } catch {}
    if (!identityMatches) {
      await session.close().catch(() => {});
      throw new CodexMultiProfileReadGatewayError();
    }
    return new CodexMultiProfileReadGateway(session, new CodexAccountGateway(session));
  }

  async readAccount(): Promise<CodexAccountRead> {
    return await this.accountGateway.readAccount();
  }

  async readRateLimits(): Promise<CodexRateLimitsRead> {
    return await this.accountGateway.readRateLimits();
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}
