import { constants } from "node:fs";
import { lstat, open, realpath, readdir } from "node:fs/promises";
import path from "node:path";

import { CodexRedemptionPrivateStateError } from "./codex-redemption-private-error.js";

const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

export type PrivateFileContext = {
  rootPath: string;
  platform: NodeJS.Platform;
  verifyPrivatePath?: (filePath: string) => Promise<void>;
};

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function readPrivateFile(
  context: PrivateFileContext,
  filePath: string,
  canonicalRoot: string,
  minimumBytes: number,
  maximumBytes: number,
  publicationCandidatePattern?: RegExp,
): Promise<Buffer> {
  await context.verifyPrivatePath?.(filePath);
  const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
  try {
    const metadata = await handle.stat();
    const pathMetadata = await lstat(filePath);
    const publicationLinkAllowed = publicationCandidatePattern && metadata.nlink === 2
      ? await hasMatchingPublicationLink(context.rootPath, filePath, metadata.dev, metadata.ino, publicationCandidatePattern)
      : false;
    if (
      !metadata.isFile() ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      metadata.dev !== pathMetadata.dev ||
      metadata.ino !== pathMetadata.ino ||
      (metadata.nlink !== 1 && !publicationLinkAllowed) ||
      metadata.size < minimumBytes ||
      metadata.size > maximumBytes ||
      (context.platform !== "win32" && ((metadata.mode & 0o777) !== 0o600 || (pathMetadata.mode & 0o777) !== 0o600))
    ) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    const canonical = await realpath(filePath);
    if (!isInsideRoot(canonicalRoot, canonical)) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      (after.nlink !== metadata.nlink && !(publicationLinkAllowed && metadata.nlink === 2 && after.nlink === 1)) ||
      (after.ctimeMs !== metadata.ctimeMs && !(publicationLinkAllowed && metadata.nlink === 2 && after.nlink === 1))
    ) throw new CodexRedemptionPrivateStateError("redemption-recovery-required");
    return content;
  } finally {
    await handle.close();
  }
}

async function hasMatchingPublicationLink(
  rootPath: string,
  publishedPath: string,
  dev: number,
  ino: number,
  candidatePattern: RegExp,
): Promise<boolean> {
  const current = await lstat(publishedPath);
  if (current.dev !== dev || current.ino !== ino) return false;
  if (current.nlink === 1) return true;
  if (current.nlink !== 2) return false;
  let matches = 0;
  for (const name of await readdir(rootPath)) {
    if (!candidatePattern.test(name)) continue;
    try {
      const candidate = await lstat(path.join(rootPath, name));
      if (candidate.isFile() && !candidate.isSymbolicLink() && candidate.dev === dev && candidate.ino === ino) matches += 1;
    } catch (error) {
      if (!isEnoent(error)) return false;
    }
  }
  const after = await lstat(publishedPath);
  if (after.dev !== dev || after.ino !== ino) return false;
  if (after.nlink === 1) return true;
  return after.nlink === 2 && matches === 1;
}
