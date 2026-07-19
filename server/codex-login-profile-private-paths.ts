import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { CodexRuntimeContext } from "./codex-runtime-context.js";
import {
  createWindowsPrivatePathSecurity,
  type WindowsPrivatePathSecurity,
} from "./codex-redemption-windows-security.js";

type CodexLoginProfilePrivatePathsDependencies = {
  managerRoot: string;
  platform?: NodeJS.Platform;
  windowsSecurity?: WindowsPrivatePathSecurity;
};

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export class CodexLoginProfilePrivatePaths {
  readonly managerRoot: string;
  readonly stateRoot: string;
  readonly profilesRoot: string;
  readonly legacyRegistryPath: string;
  readonly platform: NodeJS.Platform;
  private readonly windowsSecurity: WindowsPrivatePathSecurity;

  constructor(dependencies: CodexLoginProfilePrivatePathsDependencies) {
    this.managerRoot = path.resolve(dependencies.managerRoot);
    this.stateRoot = path.dirname(this.managerRoot);
    this.profilesRoot = path.join(this.managerRoot, "profiles");
    this.legacyRegistryPath = path.join(this.managerRoot, "registry.json");
    this.platform = dependencies.platform ?? process.platform;
    this.windowsSecurity = dependencies.windowsSecurity ?? createWindowsPrivatePathSecurity();
  }

  async ensureRoots(): Promise<void> {
    await this.ensurePrivateDirectory(this.stateRoot);
    await this.ensurePrivateDirectory(this.managerRoot);
    await this.ensurePrivateDirectory(this.profilesRoot);
  }

  async verifyRoots(): Promise<void> {
    await this.verifyPrivateDirectory(this.stateRoot);
    await this.verifyPrivateDirectory(this.managerRoot);
    await this.verifyPrivateDirectory(this.profilesRoot);
  }

  profileRoot(rootName: string): string {
    const root = path.resolve(this.profilesRoot, rootName);
    const relative = path.relative(this.profilesRoot, root);
    if (!relative || relative !== rootName || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Codex Login Profile private path unavailable.");
    }
    return root;
  }

  async ensurePrivateDirectory(directory: string): Promise<void> {
    let created = false;
    try {
      await lstat(directory);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      created = true;
    }
    await this.verifyPrivateDirectory(directory, created);
  }

  async verifyPrivateDirectory(directory: string, created = false): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Codex Login Profile private path unavailable.");
    }
    if (this.platform === "win32") {
      if (created) await this.windowsSecurity.secureCreatedDirectory(directory);
      await this.windowsSecurity.verifyPrivatePath(directory, true);
      return;
    }
    if (created) await chmod(directory, 0o700);
    const secured = await lstat(directory);
    if ((secured.mode & 0o777) !== 0o700) throw new Error("Codex Login Profile private path unavailable.");
    if (typeof process.getuid === "function" && secured.uid !== process.getuid()) {
      throw new Error("Codex Login Profile private path unavailable.");
    }
  }

  async verifyPrivateFile(filePath: string): Promise<void> {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Codex Login Profile private path unavailable.");
    }
    if (this.platform === "win32") {
      await this.windowsSecurity.verifyPrivatePath(filePath, true);
      return;
    }
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("Codex Login Profile private path unavailable.");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("Codex Login Profile private path unavailable.");
    }
  }

  async privateDirectoryExists(directory: string): Promise<boolean> {
    try {
      await this.verifyPrivateDirectory(directory);
      return true;
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  async runtimeContext(rootName: string): Promise<CodexRuntimeContext> {
    const profileRoot = this.profileRoot(rootName);
    await this.verifyPrivateDirectory(profileRoot);
    const canonicalProfilesRoot = await realpath(this.profilesRoot);
    const canonicalRoot = await realpath(profileRoot);
    if (path.relative(canonicalProfilesRoot, canonicalRoot) !== rootName) {
      throw new Error("Codex Login Profile private path unavailable.");
    }
    return { codexStateRoot: canonicalRoot, codexSqliteRoot: canonicalRoot };
  }

  async writePrivateJsonTemp(tempPath: string, value: unknown): Promise<void> {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      if (this.platform !== "win32") await handle.chmod(0o600);
    } finally {
      await handle.close();
    }
    if (this.platform === "win32") {
      if (!this.windowsSecurity.secureCreatedFile) {
        throw new Error("Codex Login Profile private path unavailable.");
      }
      await this.windowsSecurity.secureCreatedFile(tempPath);
    }
    await this.verifyPrivateFile(tempPath);
  }
}
