import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { CodexRuntimeContext } from "./codex-runtime-context.js";
import {
  assertRegistryEntry,
  assertRegistryCleanupEntry,
  discoverLegacyCancellationArtifacts,
  isRegistryProfileId,
  syncRegistryDirectory,
  type RegistryCleanupEntry as CleanupEntry,
  type RegistryEntry,
} from "./codex-login-profile-registry-migration.js";
import { createWindowsPrivatePathSecurity, type WindowsPrivatePathSecurity } from "./codex-redemption-windows-security.js";

export type CodexLoginProfileStatus = "pending" | "confirmed";
export type CodexLoginProfileRecord = Readonly<{
  id: string;
  status: CodexLoginProfileStatus;
  runtimeContext: CodexRuntimeContext;
}>;
type RegistryState = {
  schemaVersion: 2;
  generation: number;
  idNamespace: string;
  profiles: RegistryEntry[];
  cleanup: CleanupEntry[];
};

type CodexLoginProfileRegistryDependencies = {
  managerRoot: string;
  platform?: NodeJS.Platform;
  generateId?: () => string;
  windowsSecurity?: WindowsPrivatePathSecurity;
  renamePath?: typeof rename;
  linkPath?: typeof link;
  removePath?: (targetPath: string, options: { recursive: true; force: boolean }) => Promise<void>;
};
const STATE_FILE_PATTERN = /^\.registry-state\.([1-9][0-9]*)\.json$/;
const ID_NAMESPACE_PATTERN = /^[0-9a-z]{0,16}$/;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

export class CodexLoginProfileRegistryError extends Error {
  constructor() {
    super("Codex Login Profile registry unavailable.");
    this.name = "CodexLoginProfileRegistryError";
  }
}

export class CodexLoginProfileRegistry {
  private readonly managerRoot: string;
  private readonly stateRoot: string;
  private readonly profilesRoot: string;
  private readonly registryPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly generateId: () => string;
  private readonly windowsSecurity: WindowsPrivatePathSecurity;
  private readonly renamePath: typeof rename;
  private readonly linkPath: typeof link;
  private readonly removePath: (targetPath: string, options: { recursive: true; force: boolean }) => Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(dependencies: CodexLoginProfileRegistryDependencies) {
    this.managerRoot = path.resolve(dependencies.managerRoot);
    this.stateRoot = path.dirname(this.managerRoot);
    this.profilesRoot = path.join(this.managerRoot, "profiles");
    this.registryPath = path.join(this.managerRoot, "registry.json");
    this.platform = dependencies.platform ?? process.platform;
    this.generateId = dependencies.generateId ?? (() => randomBytes(24).toString("base64url"));
    this.windowsSecurity = dependencies.windowsSecurity ?? createWindowsPrivatePathSecurity();
    this.renamePath = dependencies.renamePath ?? rename;
    this.linkPath = dependencies.linkPath ?? link;
    this.removePath = dependencies.removePath ?? rm;
  }

  async create(): Promise<CodexLoginProfileRecord> {
    return await this.withMutation(async () => {
      let rawId: string;
      try {
        await this.ensurePrivateDirectory(this.stateRoot);
        await this.ensurePrivateDirectory(this.managerRoot);
        await this.ensurePrivateDirectory(this.profilesRoot);
        rawId = this.generateId();
        this.assertProfileId(rawId);
      } catch (error) {
        if (error instanceof CodexLoginProfileRegistryError) throw error;
        throw new CodexLoginProfileRegistryError();
      }
      for (;;) {
        let rootPath: string | undefined;
        try {
          const state = await this.settleState();
          const id = this.deriveProfileId(rawId, state.idNamespace);
          if (state.profiles.some((entry) => entry.id === id)) throw new CodexLoginProfileRegistryError();
          const rootName = `.${id}.${randomBytes(12).toString("hex")}.profile`;
          const entry: RegistryEntry = { id, status: "pending", rootName };
            assertRegistryEntry(entry);
          rootPath = path.join(this.profilesRoot, rootName);
          await this.ensurePrivateDirectory(rootPath);
          const committed = await this.tryCommitState(state, {
            ...state,
            profiles: [...state.profiles, entry],
          });
          if (!committed) {
            await rm(rootPath, { recursive: true, force: true }).catch(() => {});
            continue;
          }
          return await this.recordFor(entry);
        } catch (error) {
          if (rootPath) {
            const committed = await this.loadState().then(
              (state) => state.profiles.some((entry) => entry.rootName === path.basename(rootPath!)), () => true);
            if (!committed) await rm(rootPath, { recursive: true, force: true }).catch(() => {});
          }
          if (error instanceof CodexLoginProfileRegistryError) throw error;
          throw new CodexLoginProfileRegistryError();
        }
      }
    });
  }

  async get(id: string): Promise<CodexLoginProfileRecord> {
    try {
      this.assertProfileId(id);
      await this.verifyPrivateRoots();
      const state = await this.settleState();
      const entry = state.profiles.find((candidate) => candidate.id === id && !candidate.cancelingRootName);
      if (!entry) throw new CodexLoginProfileRegistryError();
      return await this.recordFor(entry);
    } catch (error) {
      if (error instanceof CodexLoginProfileRegistryError) throw error;
      throw new CodexLoginProfileRegistryError();
    }
  }

  async confirm(id: string): Promise<CodexLoginProfileRecord> {
    return await this.withMutation(async () => {
      this.assertProfileId(id);
      for (;;) {
        try {
          await this.verifyPrivateRoots();
          const state = await this.settleState();
          const entry = state.profiles.find((candidate) => candidate.id === id);
          if (!entry || entry.status !== "pending" || entry.cancelingRootName) {
            throw new CodexLoginProfileRegistryError();
          }
          await this.recordFor(entry);
          const confirmed = { ...entry, status: "confirmed" as const };
          const committed = await this.tryCommitState(state, {
            ...state,
            profiles: state.profiles.map((candidate) => (candidate.id === id ? confirmed : candidate)),
          });
          if (!committed) continue;
          return await this.recordFor(confirmed);
        } catch (error) {
          if (error instanceof CodexLoginProfileRegistryError) throw error;
          throw new CodexLoginProfileRegistryError();
        }
      }
    });
  }

  async cancel(id: string): Promise<void> {
    await this.withMutation(async () => {
      this.assertProfileId(id);
      for (;;) {
        try {
          await this.verifyPrivateRoots();
          const state = await this.settleState();
          if (state.cleanup.length > 0 || state.profiles.some((candidate) => candidate.cancelingRootName)) {
            throw new CodexLoginProfileRegistryError();
          }
          const entry = state.profiles.find((candidate) => candidate.id === id);
          if (!entry || entry.status !== "pending" || entry.cancelingRootName) {
            throw new CodexLoginProfileRegistryError();
          }
          await this.recordFor(entry);
          const cancelingRootName = `.${id}.${randomBytes(12).toString("hex")}.canceling`;
          const reserved = { ...entry, cancelingRootName };
          const committed = await this.tryCommitState(state, {
            ...state,
            profiles: state.profiles.map((candidate) => (candidate.id === id ? reserved : candidate)),
          });
          if (!committed) continue;
          await this.finishReservedCancellation(reserved);
          return;
        } catch (error) {
          if (error instanceof CodexLoginProfileRegistryError) throw error;
          throw new CodexLoginProfileRegistryError();
        }
      }
    });
  }
  private async verifyPrivateRoots(): Promise<void> {
    await this.verifyPrivateDirectory(this.stateRoot);
    await this.verifyPrivateDirectory(this.managerRoot);
    await this.verifyPrivateDirectory(this.profilesRoot);
  }
  private assertProfileId(id: string): void {
    if (!isRegistryProfileId(id)) throw new CodexLoginProfileRegistryError();
  }
  private deriveProfileId(rawId: string, namespace: string): string {
    if (!namespace) return rawId;
    return `profile_${createHash("sha256").update(rawId).digest("base64url")}_${namespace}`;
  }
  private profileRoot(rootName: string): string {
    const root = path.resolve(this.profilesRoot, rootName);
    const relative = path.relative(this.profilesRoot, root);
    if (!relative || relative !== rootName || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new CodexLoginProfileRegistryError();
    }
    return root;
  }
  private async ensurePrivateDirectory(directory: string): Promise<void> {
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
  private async verifyPrivateDirectory(directory: string, created = false): Promise<void> {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new CodexLoginProfileRegistryError();
    if (this.platform === "win32") {
      if (created) await this.windowsSecurity.secureCreatedDirectory(directory);
      await this.windowsSecurity.verifyPrivatePath(directory, true);
      return;
    }
    if (created) await chmod(directory, 0o700);
    const secured = await lstat(directory);
    if ((secured.mode & 0o777) !== 0o700) throw new CodexLoginProfileRegistryError();
    if (typeof process.getuid === "function" && secured.uid !== process.getuid()) {
      throw new CodexLoginProfileRegistryError();
    }
  }
  private async verifyPrivateFile(filePath: string): Promise<void> {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new CodexLoginProfileRegistryError();
    if (this.platform === "win32") {
      await this.windowsSecurity.verifyPrivatePath(filePath, true);
      return;
    }
    if ((metadata.mode & 0o777) !== 0o600) throw new CodexLoginProfileRegistryError();
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new CodexLoginProfileRegistryError();
    }
  }
  private async settleState(): Promise<RegistryState> {
    for (;;) {
      let state = await this.loadState();
      if (state.generation === 0) {
        const migrated = await this.tryMigrateLegacyArtifacts(state);
        if (!migrated) continue;
        state = migrated;
      }
      const completedIds = new Set<string>();
      const newCleanup: CleanupEntry[] = [];
      for (const entry of state.profiles) {
        if (!entry.cancelingRootName) continue;
        if (await this.tryMoveToCancellationRoot(entry)) {
          completedIds.add(entry.id);
          newCleanup.push({ id: entry.id, kind: "canceling-root", name: entry.cancelingRootName });
        }
      }
      if (completedIds.size > 0) {
        const committed = await this.tryCommitState(state, {
          ...state,
          idNamespace: (state.generation + 1).toString(36),
          profiles: state.profiles.filter((entry) => !completedIds.has(entry.id)),
          cleanup: [...state.cleanup, ...newCleanup],
        });
        if (!committed) continue;
        state = committed;
      }
      const remainingCleanup: CleanupEntry[] = [];
      for (const cleanup of state.cleanup) {
        if (!(await this.tryCleanup(cleanup))) remainingCleanup.push(cleanup);
      }
      if (remainingCleanup.length !== state.cleanup.length) {
        const committed = await this.tryCommitState(state, { ...state, cleanup: remainingCleanup });
        if (!committed) continue;
        state = committed;
      }
      await this.cleanupOldStateFiles();
      return state;
    }
  }

  private async finishReservedCancellation(entry: RegistryEntry): Promise<void> {
    const oldRoot = this.profileRoot(entry.rootName);
    const cancelingRoot = this.profileRoot(entry.cancelingRootName!);
    await this.renamePath(oldRoot, cancelingRoot).catch(() => {});
    const settled = await this.settleState();
    if (settled.profiles.some((candidate) => candidate.id === entry.id) ||
        settled.cleanup.some((candidate) => candidate.id === entry.id)) {
      throw new CodexLoginProfileRegistryError();
    }
  }

  private async tryMoveToCancellationRoot(entry: RegistryEntry): Promise<boolean> {
    const oldRoot = this.profileRoot(entry.rootName);
    const cancelingRoot = this.profileRoot(entry.cancelingRootName!);
    if (await this.privateDirectoryExists(cancelingRoot)) return true;
    if (!(await this.privateDirectoryExists(oldRoot))) return true;
    try {
      await this.renamePath(oldRoot, cancelingRoot);
      return true;
    } catch {
      return await this.privateDirectoryExists(cancelingRoot);
    }
  }
  private async tryCleanup(cleanup: CleanupEntry): Promise<boolean> {
    const targetPath = this.profileRoot(cleanup.name);
    if (cleanup.kind !== "marker") {
      if (await this.privateDirectoryExists(targetPath)) {
        try {
          await this.removePath(targetPath, { recursive: true, force: true });
        } catch {
          return false;
        }
      }
    } else {
      try {
        await this.verifyPrivateFile(targetPath);
        await rm(targetPath, { force: true });
      } catch (error) {
        if (!isEnoent(error)) return false;
      }
    }
    return true;
  }

  private async tryMigrateLegacyArtifacts(state: RegistryState): Promise<RegistryState | null> {
    const artifacts = await discoverLegacyCancellationArtifacts({
      profilesRoot: this.profilesRoot,
      verifyPrivateDirectory: async (targetPath) => await this.verifyPrivateDirectory(targetPath),
      verifyPrivateFile: async (targetPath) => await this.verifyPrivateFile(targetPath),
    });
    if (!artifacts) return null;
    return await this.tryCommitState(state, {
      ...state,
      idNamespace: artifacts.canceledIds.size > 0 ? (state.generation + 1).toString(36) : state.idNamespace,
      profiles: state.profiles.filter((entry) => !artifacts.canceledIds.has(entry.id)),
      cleanup: [...state.cleanup, ...artifacts.cleanup],
    });
  }

  private async loadState(): Promise<RegistryState> {
    for (;;) {
      const generations = await this.stateGenerations();
      const generation = generations.at(-1);
      if (generation !== undefined) {
        try {
          return await this.readStateFile(this.statePath(generation), generation);
        } catch (error) {
          if (isEnoent(error)) continue;
          throw error;
        }
      }
      return await this.readLegacyState();
    }
  }

  private async readLegacyState(): Promise<RegistryState> {
    let parsed: unknown;
    try {
      await this.verifyPrivateFile(this.registryPath);
      parsed = JSON.parse(await readFile(this.registryPath, "utf8")) as unknown;
    } catch (error) {
      if (isEnoent(error)) {
        return {
          schemaVersion: 2,
          generation: 0,
          idNamespace: "",
          profiles: [],
          cleanup: [],
        };
      }
      throw error;
    }
    if ((parsed as { schemaVersion?: unknown } | null)?.schemaVersion === 2) {
      throw new CodexLoginProfileRegistryError();
    }
    const profiles = this.parseLegacyProfiles(parsed);
    return {
      schemaVersion: 2,
      generation: 0,
      idNamespace: "",
      profiles,
      cleanup: [],
    };
  }

  private parseLegacyProfiles(parsed: unknown): RegistryEntry[] {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CodexLoginProfileRegistryError();
    }
    const rawProfiles = (parsed as { profiles?: unknown }).profiles;
    if (!Array.isArray(rawProfiles)) {
      throw new CodexLoginProfileRegistryError();
    }
    const profiles = rawProfiles.map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new CodexLoginProfileRegistryError();
      }
      const entry = raw as { id?: unknown; status?: unknown };
      if (typeof entry.id !== "string" || (entry.status !== "pending" && entry.status !== "confirmed")) {
        throw new CodexLoginProfileRegistryError();
      }
      const migrated = { id: entry.id, status: entry.status, rootName: entry.id };
      assertRegistryEntry(migrated);
      return migrated;
    });
    if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) {
      throw new CodexLoginProfileRegistryError();
    }
    return profiles;
  }

  private async readStateFile(filePath: string, expectedGeneration: number): Promise<RegistryState> {
    await this.verifyPrivateFile(filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CodexLoginProfileRegistryError();
    }
    const raw = parsed as Partial<RegistryState>;
    if (
      raw.schemaVersion !== 2 ||
      raw.generation !== expectedGeneration ||
      !Number.isSafeInteger(raw.generation) ||
      raw.generation < 1 ||
      typeof raw.idNamespace !== "string" ||
      !ID_NAMESPACE_PATTERN.test(raw.idNamespace) ||
      !Array.isArray(raw.profiles) ||
      !Array.isArray(raw.cleanup)
    ) {
      throw new CodexLoginProfileRegistryError();
    }
    const profiles = raw.profiles.map((entry) => {
      assertRegistryEntry(entry);
      return { ...entry };
    });
    const cleanup = raw.cleanup.map((entry) => {
      assertRegistryCleanupEntry(entry);
      return { ...entry };
    });
    if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) {
      throw new CodexLoginProfileRegistryError();
    }
    return { ...raw, profiles, cleanup } as RegistryState;
  }

  private async tryCommitState(
    previous: RegistryState,
    next: Omit<RegistryState, "generation">,
  ): Promise<RegistryState | null> {
    const retained = await this.stateGenerations();
    if (retained.length > 2) {
      await this.cleanupOldStateFiles();
      if ((await this.stateGenerations()).length > 2) {
        throw new CodexLoginProfileRegistryError();
      }
    }
    const generation = previous.generation + 1;
    if (!Number.isSafeInteger(generation)) {
      throw new CodexLoginProfileRegistryError();
    }
    const state: RegistryState = { ...next, schemaVersion: 2, generation };
    const statePath = this.statePath(generation);
    const tempPath = path.join(this.managerRoot, `.registry-state.${randomBytes(12).toString("hex")}.tmp`);
    try {
      await this.writePrivateJsonTemp(tempPath, state);
      try {
        await this.linkPath(tempPath, statePath);
      } catch (error) {
        if (isEexist(error)) return null;
        throw error;
      }
      await syncRegistryDirectory(this.managerRoot, this.platform);
      await this.verifyPrivateFile(statePath);
      const generations = await this.stateGenerations();
      if (generations.at(-1) !== generation) {
        await rm(statePath, { force: true }).catch(() => {});
        await syncRegistryDirectory(this.managerRoot, this.platform);
        return null;
      }
      await this.cleanupOldStateFiles();
      return state;
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }

  private async writePrivateJsonTemp(tempPath: string, value: unknown): Promise<void> {
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
      if (this.platform !== "win32") {
        await handle.chmod(0o600);
      }
    } finally {
      await handle.close();
    }
    if (this.platform === "win32") {
      if (!this.windowsSecurity.secureCreatedFile) {
        throw new CodexLoginProfileRegistryError();
      }
      await this.windowsSecurity.secureCreatedFile(tempPath);
    }
    await this.verifyPrivateFile(tempPath);
  }

  private async stateGenerations(): Promise<number[]> {
    return (await readdir(this.managerRoot))
      .map((name) => STATE_FILE_PATTERN.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number)
      .filter((value) => Number.isSafeInteger(value))
      .sort((left, right) => left - right);
  }

  private statePath(generation: number): string {
    return path.join(this.managerRoot, `.registry-state.${generation}.json`);
  }

  private async cleanupOldStateFiles(revalidate = true): Promise<void> {
    const latest = (await this.stateGenerations()).at(-1);
    if (latest === undefined) return;
    let removed = false;
    for (const generation of await this.stateGenerations()) {
      if (generation >= latest) continue;
      try {
        await rm(this.statePath(generation), { force: true });
        removed = true;
      } catch {
        // Best-effort GC; bounded-state guard in tryCommitState fails closed if old generations remain.
      }
    }
    if (removed) await syncRegistryDirectory(this.managerRoot, this.platform);
    if (revalidate && (await this.stateGenerations()).at(-1) !== latest) {
      await this.cleanupOldStateFiles(false);
    }
  }

  private async privateDirectoryExists(directory: string): Promise<boolean> {
    try {
      await this.verifyPrivateDirectory(directory);
      return true;
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  private async withMutation<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private async recordFor(entry: RegistryEntry): Promise<CodexLoginProfileRecord> {
    const profileRoot = this.profileRoot(entry.rootName);
    await this.verifyPrivateDirectory(profileRoot);
    const canonicalProfilesRoot = await realpath(this.profilesRoot);
    const canonicalRoot = await realpath(profileRoot);
    if (path.relative(canonicalProfilesRoot, canonicalRoot) !== entry.rootName) {
      throw new CodexLoginProfileRegistryError();
    }
    return {
      id: entry.id,
      status: entry.status,
      runtimeContext: { codexStateRoot: canonicalRoot, codexSqliteRoot: canonicalRoot },
    };
  }
}
