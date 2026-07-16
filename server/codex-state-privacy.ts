import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  createWindowsPrivatePathSecurity,
  type WindowsPrivatePathSecurity,
} from "./codex-redemption-windows-security.js";

type CodexStateEnvironment = { CODEX_HOME?: string };

type CodexStatePrivacyDependencies = {
  platform: NodeJS.Platform;
  env: CodexStateEnvironment;
  homedir: () => string;
  codexStateRootForTests?: string;
  windowsSecurity?: WindowsPrivatePathSecurity;
};

export class CodexStatePrivacyError extends Error {
  constructor() {
    super("Codex state privacy unavailable.");
    this.name = "CodexStatePrivacyError";
  }
}

async function verifyTrustedAncestry(root: string, trustedRoot: string): Promise<void> {
  const relative = path.relative(trustedRoot, root);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new CodexStatePrivacyError();
  let current = trustedRoot;
  const segments = relative ? relative.split(path.sep) : [];
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    const metadata = await lstat(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CodexStatePrivacyError();
  }
}

export function resolveCodexStateRoot(
  platform: NodeJS.Platform,
  env: CodexStateEnvironment,
  homedir: () => string,
): string {
  const pathApi = platform === "win32" ? path.win32 : path;
  const configured = env.CODEX_HOME?.trim();
  if (configured) {
    if (!pathApi.isAbsolute(configured)) throw new CodexStatePrivacyError();
    return pathApi.normalize(configured);
  }
  return pathApi.join(homedir(), ".codex");
}

export async function verifyCodexStateRoot(dependencies: CodexStatePrivacyDependencies): Promise<string> {
  const root = dependencies.codexStateRootForTests ?? resolveCodexStateRoot(
    dependencies.platform,
    dependencies.env,
    dependencies.homedir,
  );
  try {
    await verifyTrustedAncestry(root, dependencies.homedir());
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CodexStatePrivacyError();
    if (dependencies.platform === "win32") {
      const security = dependencies.windowsSecurity ?? createWindowsPrivatePathSecurity();
      await security.verifyPrivatePath(root, false);
    } else {
      if ((metadata.mode & 0o077) !== 0) throw new CodexStatePrivacyError();
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new CodexStatePrivacyError();
    }
    return await realpath(root);
  } catch (error) {
    if (error instanceof CodexStatePrivacyError) throw error;
    throw new CodexStatePrivacyError();
  }
}
