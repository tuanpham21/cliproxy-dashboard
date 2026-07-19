import { randomBytes as nodeRandomBytes } from "node:crypto";
import { link, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { CodexLoginProfilePrivatePaths } from "./codex-login-profile-private-paths.js";
import { isRegistryProfileId, syncRegistryDirectory } from "./codex-login-profile-registry-migration.js";
import {
  currentProcessOwner,
  inspectProcessOwner,
  type ProcessOwner,
  type ProcessOwnerStatus,
} from "./codex-redemption-private-owner.js";
import type { WindowsPrivatePathSecurity } from "./codex-redemption-windows-security.js";

export type CodexProfileLifecycleOperation = "prepare" | "consume" | "refresh" | "disable" | "re-login" | "delete";

type FenceState = {
  schemaVersion: 1;
  profileId: string;
  operation: CodexProfileLifecycleOperation;
  ownerNonce: string;
  owner: ProcessOwner;
};

type CodexProfileLifecycleFenceDependencies = {
  managerRoot: string;
  platform?: NodeJS.Platform;
  windowsSecurity?: WindowsPrivatePathSecurity;
  currentOwner?: () => Promise<ProcessOwner>;
  inspectOwner?: (owner: ProcessOwner) => Promise<ProcessOwnerStatus>;
  randomBytes?: (size: number) => Buffer;
  linkPath?: typeof link;
  renamePath?: typeof rename;
  removePath?: (targetPath: string) => Promise<void>;
};

export class CodexProfileLifecycleFenceError extends Error {
  constructor(readonly code: "profile-busy" | "unavailable") {
    super(code === "profile-busy" ? "Codex Login Profile is busy." : "Codex Login Profile lifecycle unavailable.");
    this.name = "CodexProfileLifecycleFenceError";
  }
}

export type CodexProfileLifecycleLease = Readonly<{
  profileId: string;
  operation: CodexProfileLifecycleOperation;
  release(): Promise<void>;
}>;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function statesMatch(left: FenceState, right: FenceState): boolean {
  return left.profileId === right.profileId && left.operation === right.operation && left.ownerNonce === right.ownerNonce &&
    left.owner.pid === right.owner.pid && left.owner.processStartIdentity === right.owner.processStartIdentity;
}

export class CodexProfileLifecycleFence {
  private readonly privatePaths: CodexLoginProfilePrivatePaths;
  private readonly fencesRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly currentOwner: () => Promise<ProcessOwner>;
  private readonly inspectOwner: (owner: ProcessOwner) => Promise<ProcessOwnerStatus>;
  private readonly randomBytes: (size: number) => Buffer;
  private readonly linkPath: typeof link;
  private readonly renamePath: typeof rename;
  private readonly removePath: (targetPath: string) => Promise<void>;

  constructor(dependencies: CodexProfileLifecycleFenceDependencies) {
    this.privatePaths = new CodexLoginProfilePrivatePaths(dependencies);
    this.fencesRoot = path.join(this.privatePaths.managerRoot, "lifecycle-fences");
    this.platform = dependencies.platform ?? process.platform;
    this.currentOwner = dependencies.currentOwner ?? (() => currentProcessOwner(this.platform));
    this.inspectOwner = dependencies.inspectOwner ?? ((owner) => inspectProcessOwner(this.platform, owner));
    this.randomBytes = dependencies.randomBytes ?? nodeRandomBytes;
    this.linkPath = dependencies.linkPath ?? link;
    this.renamePath = dependencies.renamePath ?? rename;
    this.removePath = dependencies.removePath ?? (async (targetPath) => await rm(targetPath, { force: true }));
  }

  async acquire(profileId: string, operation: CodexProfileLifecycleOperation): Promise<CodexProfileLifecycleLease> {
    if (!isRegistryProfileId(profileId)) throw new CodexProfileLifecycleFenceError("unavailable");
    try {
      await this.privatePaths.ensureRoots();
      await this.privatePaths.ensurePrivateDirectory(this.fencesRoot);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state: FenceState = {
          schemaVersion: 1,
          profileId,
          operation,
          ownerNonce: this.randomBytes(32).toString("base64url"),
          owner: await this.currentOwner(),
        };
        const candidatePath = path.join(this.fencesRoot, `.lifecycle-fence.${this.randomBytes(12).toString("hex")}.tmp`);
        try {
          await this.privatePaths.writePrivateJsonTemp(candidatePath, state);
          try {
            await this.linkPath(candidatePath, this.fencePath(profileId));
          } catch (error) {
            if (!isEexist(error)) throw error;
            await this.recoverExisting(profileId);
            continue;
          }
          await syncRegistryDirectory(this.fencesRoot, this.platform);
          const authoritative = await this.readFence(this.fencePath(profileId), profileId);
          if (!statesMatch(authoritative, state)) throw new CodexProfileLifecycleFenceError("unavailable");
          let released = false;
          return {
            profileId,
            operation,
            release: async () => {
              if (released) return;
              await this.release(state);
              released = true;
            },
          };
        } finally {
          await this.removePath(candidatePath).catch(() => {});
        }
      }
      throw new CodexProfileLifecycleFenceError("profile-busy");
    } catch (error) {
      if (error instanceof CodexProfileLifecycleFenceError) throw error;
      throw new CodexProfileLifecycleFenceError("unavailable");
    }
  }

  private async recoverExisting(profileId: string): Promise<void> {
    const existing = await this.readFence(this.fencePath(profileId), profileId);
    const ownerStatus = await this.inspectOwner(existing.owner);
    if (ownerStatus === "alive") throw new CodexProfileLifecycleFenceError("profile-busy");
    if (ownerStatus === "unverifiable") throw new CodexProfileLifecycleFenceError("unavailable");
    await this.moveAndRemove(existing);
  }

  private async release(expected: FenceState): Promise<void> {
    const existing = await this.readFence(this.fencePath(expected.profileId), expected.profileId);
    if (!statesMatch(existing, expected)) throw new CodexProfileLifecycleFenceError("unavailable");
    await this.moveAndRemove(existing);
  }

  private async moveAndRemove(expected: FenceState): Promise<void> {
    const sourcePath = this.fencePath(expected.profileId);
    const cleanupPath = path.join(
      this.fencesRoot,
      `.lifecycle-fence.${expected.profileId}.${this.randomBytes(12).toString("hex")}.cleanup`,
    );
    try {
      await this.renamePath(sourcePath, cleanupPath);
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    await syncRegistryDirectory(this.fencesRoot, this.platform);
    const moved = await this.readFence(cleanupPath, expected.profileId);
    if (!statesMatch(moved, expected)) {
      await this.renamePath(cleanupPath, sourcePath).catch(() => {});
      await syncRegistryDirectory(this.fencesRoot, this.platform).catch(() => {});
      throw new CodexProfileLifecycleFenceError("unavailable");
    }
    await this.removePath(cleanupPath);
    await syncRegistryDirectory(this.fencesRoot, this.platform);
  }

  private async readFence(filePath: string, profileId: string): Promise<FenceState> {
    await this.privatePaths.verifyPrivateFile(filePath);
    const text = await readFile(filePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 4_096) throw new CodexProfileLifecycleFenceError("unavailable");
    const value = JSON.parse(text) as Partial<FenceState> | null;
    if (!value || Object.keys(value).sort().join(",") !== "operation,owner,ownerNonce,profileId,schemaVersion" ||
      value.schemaVersion !== 1 || value.profileId !== profileId ||
      !["prepare", "consume", "refresh", "disable", "re-login", "delete"].includes(value.operation ?? "") ||
      typeof value.ownerNonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.ownerNonce) ||
      !value.owner || Object.keys(value.owner).sort().join(",") !== "pid,processStartIdentity" ||
      !Number.isSafeInteger(value.owner.pid) || value.owner.pid <= 0 ||
      typeof value.owner.processStartIdentity !== "string" || !value.owner.processStartIdentity) {
      throw new CodexProfileLifecycleFenceError("unavailable");
    }
    return value as FenceState;
  }

  private fencePath(profileId: string): string {
    return path.join(this.fencesRoot, `.${profileId}.lifecycle-fence.json`);
  }
}
