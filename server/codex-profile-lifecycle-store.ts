import { randomBytes } from "node:crypto";
import { link, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { CodexLoginProfilePrivatePaths } from "./codex-login-profile-private-paths.js";
import { isRegistryProfileId, syncRegistryDirectory } from "./codex-login-profile-registry-migration.js";
import type { WindowsPrivatePathSecurity } from "./codex-redemption-windows-security.js";

export type CodexProfileCleanupRequired = Readonly<{
  profileId: string;
  label: string;
  order: number;
}>;

type CleanupState = CodexProfileCleanupRequired & { schemaVersion: 1; state: "cleanup-required" };

type CodexProfileLifecycleStoreDependencies = {
  managerRoot: string;
  platform?: NodeJS.Platform;
  windowsSecurity?: WindowsPrivatePathSecurity;
  linkPath?: typeof link;
  removePath?: (targetPath: string) => Promise<void>;
};

const CLEANUP_FILE_PATTERN = /^\.([A-Za-z0-9_-]{24,80})\.cleanup-required\.json$/;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

export class CodexProfileLifecycleStoreError extends Error {
  constructor() {
    super("Codex Login Profile lifecycle state unavailable.");
    this.name = "CodexProfileLifecycleStoreError";
  }
}

export class CodexProfileLifecycleStore {
  private readonly privatePaths: CodexLoginProfilePrivatePaths;
  private readonly lifecycleRoot: string;
  private readonly linkPath: typeof link;
  private readonly removePath: (targetPath: string) => Promise<void>;

  constructor(dependencies: CodexProfileLifecycleStoreDependencies) {
    this.privatePaths = new CodexLoginProfilePrivatePaths(dependencies);
    this.lifecycleRoot = path.join(this.privatePaths.managerRoot, "lifecycle");
    this.linkPath = dependencies.linkPath ?? link;
    this.removePath = dependencies.removePath ?? (async (targetPath) => await rm(targetPath, { force: true }));
  }

  async getCleanupRequired(profileId: string): Promise<CodexProfileCleanupRequired | null> {
    this.assertProfileId(profileId);
    try {
      await this.ensureRoot();
      return this.publicState(await this.readState(profileId));
    } catch (error) {
      if (isEnoent(error)) return null;
      if (error instanceof CodexProfileLifecycleStoreError) throw error;
      throw new CodexProfileLifecycleStoreError();
    }
  }

  async listCleanupRequired(): Promise<CodexProfileCleanupRequired[]> {
    try {
      await this.ensureRoot();
      const values = await Promise.all((await readdir(this.lifecycleRoot)).map(async (name) => {
        const profileId = CLEANUP_FILE_PATTERN.exec(name)?.[1];
        return profileId ? this.publicState(await this.readState(profileId)) : null;
      }));
      return values.filter((value): value is CodexProfileCleanupRequired => value !== null)
        .sort((left, right) => left.order - right.order || left.profileId.localeCompare(right.profileId));
    } catch (error) {
      if (error instanceof CodexProfileLifecycleStoreError) throw error;
      throw new CodexProfileLifecycleStoreError();
    }
  }

  async markCleanupRequired(input: CodexProfileCleanupRequired): Promise<void> {
    this.assertProfileId(input.profileId);
    if (!input.label.trim() || Buffer.byteLength(input.label.trim(), "utf8") > 80 ||
      !Number.isSafeInteger(input.order) || input.order < 0) {
      throw new CodexProfileLifecycleStoreError();
    }
    try {
      await this.ensureRoot();
      const state: CleanupState = {
        schemaVersion: 1,
        state: "cleanup-required",
        profileId: input.profileId,
        label: input.label.trim(),
        order: input.order,
      };
      const existing = await this.getCleanupRequired(input.profileId);
      if (existing) {
        if (existing.label === state.label && existing.order === state.order) return;
        throw new CodexProfileLifecycleStoreError();
      }
      const tempPath = path.join(this.lifecycleRoot, `.lifecycle.${randomBytes(12).toString("hex")}.tmp`);
      try {
        await this.privatePaths.writePrivateJsonTemp(tempPath, state);
        try {
          await this.linkPath(tempPath, this.statePath(input.profileId));
        } catch (error) {
          if (!isEexist(error)) throw error;
        }
        await syncRegistryDirectory(this.lifecycleRoot, this.privatePaths.platform);
        const authoritative = await this.readState(input.profileId);
        if (authoritative.label !== state.label || authoritative.order !== state.order) {
          throw new CodexProfileLifecycleStoreError();
        }
      } finally {
        await this.removePath(tempPath).catch(() => {});
      }
    } catch (error) {
      if (error instanceof CodexProfileLifecycleStoreError) throw error;
      throw new CodexProfileLifecycleStoreError();
    }
  }

  async clearCleanupRequired(profileId: string): Promise<void> {
    this.assertProfileId(profileId);
    try {
      await this.ensureRoot();
      await this.removePath(this.statePath(profileId));
      await syncRegistryDirectory(this.lifecycleRoot, this.privatePaths.platform);
      if (await this.getCleanupRequired(profileId)) throw new CodexProfileLifecycleStoreError();
    } catch (error) {
      if (error instanceof CodexProfileLifecycleStoreError) throw error;
      throw new CodexProfileLifecycleStoreError();
    }
  }

  private async ensureRoot(): Promise<void> {
    await this.privatePaths.ensureRoots();
    await this.privatePaths.ensurePrivateDirectory(this.lifecycleRoot);
  }

  private async readState(profileId: string): Promise<CleanupState> {
    const filePath = this.statePath(profileId);
    await this.privatePaths.verifyPrivateFile(filePath);
    const text = await readFile(filePath, "utf8");
    if (Buffer.byteLength(text, "utf8") > 2_048) throw new CodexProfileLifecycleStoreError();
    const value = JSON.parse(text) as Partial<CleanupState> | null;
    if (!value || Object.keys(value).sort().join(",") !== "label,order,profileId,schemaVersion,state" ||
      value.schemaVersion !== 1 || value.state !== "cleanup-required" || value.profileId !== profileId ||
      typeof value.label !== "string" || value.label !== value.label.trim() || !value.label ||
      Buffer.byteLength(value.label, "utf8") > 80 || !Number.isSafeInteger(value.order) || (value.order ?? -1) < 0) {
      throw new CodexProfileLifecycleStoreError();
    }
    return value as CleanupState;
  }

  private publicState(state: CleanupState): CodexProfileCleanupRequired {
    return { profileId: state.profileId, label: state.label, order: state.order };
  }

  private assertProfileId(profileId: string): void {
    if (!isRegistryProfileId(profileId)) throw new CodexProfileLifecycleStoreError();
  }

  private statePath(profileId: string): string {
    return path.join(this.lifecycleRoot, `.${profileId}.cleanup-required.json`);
  }
}
