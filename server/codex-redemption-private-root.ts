import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";
import type { WindowsPrivatePathSecurity } from "./codex-redemption-windows-security.js";

type PrivateRootContext = {
  platform: NodeJS.Platform;
  rootPath: string;
  rootAnchorPath: string;
  windowsSecurity?: WindowsPrivatePathSecurity;
};

const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function assertNoSymlinkAncestors(context: PrivateRootContext): Promise<void> {
  const relative = path.relative(context.rootAnchorPath, context.rootPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
  }
  try {
    const anchorMetadata = await lstat(context.rootAnchorPath);
    if (!anchorMetadata.isDirectory() || anchorMetadata.isSymbolicLink()) {
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
  } catch (error) {
    if (isEnoent(error)) return;
    if (error instanceof CodexRedemptionPrivateStateError) throw error;
    throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
  }
  let current = context.rootAnchorPath;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const metadata = await lstat(current);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
    } catch (error) {
      if (isEnoent(error)) return;
      if (error instanceof CodexRedemptionPrivateStateError) throw error;
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
  }
}

export async function verifyExistingPrivateRoot(context: PrivateRootContext): Promise<string> {
  await assertNoSymlinkAncestors(context);
  try {
    const metadata = await lstat(context.rootPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    }
    if (context.platform === "win32") {
      if (!context.windowsSecurity) throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
      await context.windowsSecurity.verifyPrivatePath(context.rootPath, true);
    } else {
      if ((metadata.mode & 0o777) !== 0o700) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
    }
    return await realpath(context.rootPath);
  } catch (error) {
    if (error instanceof CodexRedemptionPrivateStateError || isEnoent(error)) throw error;
    throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
  }
}

export async function ensureWritablePrivateRoot(context: PrivateRootContext): Promise<string> {
  await assertNoSymlinkAncestors(context);
  const created = (await mkdir(context.rootPath, { recursive: true, mode: 0o700 })) !== undefined;
  if (context.platform === "win32") {
    if (!context.windowsSecurity) throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
    if (created) {
      try {
        await context.windowsSecurity.secureCreatedDirectory(context.rootPath);
      } catch {
        throw new CodexRedemptionPrivateStateError("redemption-private-state-unavailable");
      }
    }
  } else {
    let handle;
    try {
      handle = await open(context.rootPath, READ_ONLY_NO_FOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isDirectory() || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) {
        throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
      }
      await handle.chmod(0o700);
    } catch (error) {
      if (error instanceof CodexRedemptionPrivateStateError) throw error;
      throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    } finally {
      await handle?.close();
    }
  }
  return await verifyExistingPrivateRoot(context);
}
