import os from "node:os";
import process from "node:process";

import {
  resolveCodexStateRoot,
  verifyCodexStateRoot,
} from "./codex-state-privacy.js";
import {
  createWindowsPrivatePathSecurity,
  type WindowsPrivatePathSecurity,
} from "./codex-redemption-windows-security.js";

export type CodexRuntimeContext = Readonly<{
  codexStateRoot: string;
  codexSqliteRoot: string;
}>;

export function runtimeContextFromIdentity(identity: CodexRuntimeContext): CodexRuntimeContext {
  return {
    codexStateRoot: identity.codexStateRoot,
    codexSqliteRoot: identity.codexSqliteRoot,
  };
}

export interface CodexRuntimeContextAdapterLike {
  resolve(): Promise<CodexRuntimeContext>;
}

type CodexRuntimeEnvironment = {
  CODEX_HOME?: string;
  CODEX_SQLITE_HOME?: string;
};

export type CodexRuntimeContextDependencies = {
  env?: CodexRuntimeEnvironment;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  windowsSecurity?: WindowsPrivatePathSecurity;
};

export async function verifyCodexRuntimeContext(
  context: CodexRuntimeContext,
  dependencies: Omit<CodexRuntimeContextDependencies, "env"> = {},
): Promise<CodexRuntimeContext> {
  const platform = dependencies.platform ?? process.platform;
  const homedir = dependencies.homedir ?? os.homedir;
  const windowsSecurity = dependencies.windowsSecurity ?? createWindowsPrivatePathSecurity();
  const verifyRoot = async (root: string) => await verifyCodexStateRoot({
    platform,
    env: {},
    homedir,
    codexStateRootForTests: root,
    windowsSecurity,
  });
  const codexStateRoot = await verifyRoot(context.codexStateRoot);
  const codexSqliteRoot = context.codexSqliteRoot === context.codexStateRoot
    ? codexStateRoot
    : await verifyRoot(context.codexSqliteRoot);
  return { codexStateRoot, codexSqliteRoot };
}

export class DefaultCodexRuntimeContextAdapter implements CodexRuntimeContextAdapterLike {
  private readonly dependencies: CodexRuntimeContextDependencies;

  constructor(dependencies: CodexRuntimeContextDependencies = {}) {
    this.dependencies = dependencies;
  }

  async resolve(): Promise<CodexRuntimeContext> {
    const env = this.dependencies.env ?? process.env;
    const platform = this.dependencies.platform ?? process.platform;
    const homedir = this.dependencies.homedir ?? os.homedir;
    const codexStateRoot = resolveCodexStateRoot(platform, env, homedir);
    const codexSqliteRoot = env.CODEX_SQLITE_HOME?.trim()
      ? resolveCodexStateRoot(platform, { CODEX_HOME: env.CODEX_SQLITE_HOME }, homedir)
      : codexStateRoot;
    return await verifyCodexRuntimeContext(
      { codexStateRoot, codexSqliteRoot },
      {
        platform,
        homedir,
        windowsSecurity: this.dependencies.windowsSecurity,
      },
    );
  }
}
