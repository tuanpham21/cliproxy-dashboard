import { randomUUID } from "node:crypto";
import { chmod, link, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

type PrivateFilesystemDependencies = {
  platform: NodeJS.Platform;
  randomUUID?: () => string;
  linkPath?: typeof link;
  renamePath?: typeof rename;
  unlinkPath?: typeof unlink;
  syncDirectory?: (root: string) => Promise<void>;
};

export type PrivateFilesystemCapability = {
  qualifyRoot(root: string, verifyPrivateFile: (filePath: string) => Promise<void>): Promise<void>;
  syncDirectory(root: string): Promise<void>;
};

export class PrivateFilesystemCapabilityError extends Error {
  constructor() {
    super("Private filesystem capability unavailable.");
    this.name = "PrivateFilesystemCapabilityError";
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

async function defaultSyncDirectory(root: string): Promise<void> {
  const handle = await open(root, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createPrivateFilesystemCapability(
  dependencies: PrivateFilesystemDependencies,
): PrivateFilesystemCapability {
  const makeUuid = dependencies.randomUUID ?? randomUUID;
  const linkPath = dependencies.linkPath ?? link;
  const renamePath = dependencies.renamePath ?? rename;
  const unlinkPath = dependencies.unlinkPath ?? unlink;
  const syncDirectoryPath = dependencies.syncDirectory ?? defaultSyncDirectory;
  let qualifiedRoot: string | null = null;
  let directorySync: "unknown" | "supported" = "unknown";

  const removeProbe = async (filePath: string): Promise<void> => {
    try {
      await unlinkPath(filePath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  };

  const writeProbe = async (filePath: string, content: string): Promise<void> => {
    const handle = await open(filePath, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (dependencies.platform !== "win32") await chmod(filePath, 0o600);
  };

  const probeDirectorySync = async (root: string): Promise<void> => {
    await syncDirectoryPath(root);
    directorySync = "supported";
  };

  return {
    async qualifyRoot(root: string, verifyPrivateFile: (filePath: string) => Promise<void>): Promise<void> {
      if (qualifiedRoot === root) return;
      const prefix = `.filesystem-qualification.${makeUuid()}`;
      const sourcePath = path.join(root, `${prefix}.source`);
      const occupiedPath = path.join(root, `${prefix}.occupied`);
      const linkedPath = path.join(root, `${prefix}.linked`);
      const movedPath = path.join(root, `${prefix}.moved`);
      const replacementSourcePath = path.join(root, `${prefix}.replacement-source`);
      const replacementTargetPath = path.join(root, `${prefix}.replacement-target`);
      const probePaths = [sourcePath, occupiedPath, linkedPath, movedPath, replacementSourcePath, replacementTargetPath];
      try {
        await writeProbe(sourcePath, "source");
        await writeProbe(occupiedPath, "occupied");
        await verifyPrivateFile(sourcePath);
        await verifyPrivateFile(occupiedPath);

        let rejectedExistingTarget = false;
        try {
          await linkPath(sourcePath, occupiedPath);
        } catch (error) {
          if (isEexist(error)) rejectedExistingTarget = true;
          else throw error;
        }
        if (!rejectedExistingTarget) throw new PrivateFilesystemCapabilityError();
        if ((await readFile(sourcePath, "utf8")) !== "source" || (await readFile(occupiedPath, "utf8")) !== "occupied") {
          throw new PrivateFilesystemCapabilityError();
        }

        await linkPath(sourcePath, linkedPath);
        await verifyPrivateFile(linkedPath);
        const [sourceMetadata, linkedMetadata] = await Promise.all([lstat(sourcePath), lstat(linkedPath)]);
        if (
          sourceMetadata.dev !== linkedMetadata.dev ||
          sourceMetadata.ino !== linkedMetadata.ino ||
          sourceMetadata.nlink !== 2 ||
          linkedMetadata.nlink !== 2
        ) throw new PrivateFilesystemCapabilityError();

        await renamePath(occupiedPath, movedPath);
        if ((await readFile(movedPath, "utf8")) !== "occupied") throw new PrivateFilesystemCapabilityError();
        await writeProbe(replacementSourcePath, "replacement");
        await writeProbe(replacementTargetPath, "original");
        await renamePath(replacementSourcePath, replacementTargetPath);
        if ((await readFile(replacementTargetPath, "utf8")) !== "replacement") throw new PrivateFilesystemCapabilityError();
        try {
          await lstat(replacementSourcePath);
          throw new PrivateFilesystemCapabilityError();
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
        await verifyPrivateFile(replacementTargetPath);
        await probeDirectorySync(root);
        qualifiedRoot = root;
      } catch (error) {
        if (error instanceof PrivateFilesystemCapabilityError) throw error;
        throw new PrivateFilesystemCapabilityError();
      } finally {
        let cleanupFailed = false;
        for (const filePath of probePaths) {
          try {
            await removeProbe(filePath);
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed) {
          qualifiedRoot = null;
          throw new PrivateFilesystemCapabilityError();
        }
      }
    },
    async syncDirectory(root: string): Promise<void> {
      if (qualifiedRoot !== root || directorySync === "unknown") throw new PrivateFilesystemCapabilityError();
      try {
        await syncDirectoryPath(root);
      } catch {
        throw new PrivateFilesystemCapabilityError();
      }
    },
  };
}
