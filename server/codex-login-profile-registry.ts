import { createHash, randomBytes } from "node:crypto";
import { link, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { CodexRuntimeContext } from "./codex-runtime-context.js";
import { CodexLoginProfilePrivatePaths } from "./codex-login-profile-private-paths.js";
import {
  assertRegistryEntry,
  assertRegistryCleanupEntry,
  discoverLegacyCancellationArtifacts,
  defaultRegistryProfileLabel,
  isRegistryProfileId,
  normalizeRegistryEntry,
  syncRegistryDirectory,
  type RegistryCleanupEntry as CleanupEntry,
  type RegistryEntry,
} from "./codex-login-profile-registry-migration.js";
import type { WindowsPrivatePathSecurity } from "./codex-redemption-windows-security.js";

export type CodexLoginProfileStatus = "pending" | "confirmed";
export type CodexLoginProfileRecord = Readonly<{
  id: string;
  status: CodexLoginProfileStatus;
  label: string;
  enabled: boolean;
  order: number;
  runtimeContext: CodexRuntimeContext;
}>;
export type CodexLoginProfileMetadataInput = Readonly<{ label?: string; enabled?: boolean }>;
type RegistryState = {
  schemaVersion: 3;
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
  private readonly profilesRoot: string;
  private readonly registryPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly privatePaths: CodexLoginProfilePrivatePaths;
  private readonly generateId: () => string;
  private readonly renamePath: typeof rename;
  private readonly linkPath: typeof link;
  private readonly removePath: (targetPath: string, options: { recursive: true; force: boolean }) => Promise<void>;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(dependencies: CodexLoginProfileRegistryDependencies) {
    this.privatePaths = new CodexLoginProfilePrivatePaths(dependencies);
    this.managerRoot = this.privatePaths.managerRoot;
    this.profilesRoot = this.privatePaths.profilesRoot;
    this.registryPath = this.privatePaths.legacyRegistryPath;
    this.platform = this.privatePaths.platform;
    this.generateId = dependencies.generateId ?? (() => randomBytes(24).toString("base64url"));
    this.renamePath = dependencies.renamePath ?? rename;
    this.linkPath = dependencies.linkPath ?? link;
    this.removePath = dependencies.removePath ?? rm;
  }

  async create(): Promise<CodexLoginProfileRecord> {
    return await this.withMutation(async () => {
      let rawId: string;
      try {
        await this.privatePaths.ensureRoots();
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
          const entry: RegistryEntry = {
            id,
            status: "pending",
            rootName,
            label: defaultRegistryProfileLabel(state.profiles.length),
            enabled: false,
          };
          assertRegistryEntry(entry);
          rootPath = path.join(this.profilesRoot, rootName);
          await this.privatePaths.ensurePrivateDirectory(rootPath);
          const committed = await this.tryCommitState(state, {
            ...state,
            profiles: [...state.profiles, entry],
          });
          if (!committed) {
            await rm(rootPath, { recursive: true, force: true }).catch(() => {});
            continue;
          }
          return await this.recordFor(entry, state.profiles.length);
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
      await this.privatePaths.verifyRoots();
      const state = await this.settleState();
      const entry = state.profiles.find((candidate) => candidate.id === id && !candidate.cancelingRootName);
      if (!entry) throw new CodexLoginProfileRegistryError();
      return await this.recordFor(entry, state.profiles.indexOf(entry));
    } catch (error) {
      if (error instanceof CodexLoginProfileRegistryError) throw error;
      throw new CodexLoginProfileRegistryError();
    }
  }

  async list(): Promise<CodexLoginProfileRecord[]> {
    try {
      await this.privatePaths.ensureRoots();
      return await this.recordsFor(await this.settleState());
    } catch (error) {
      if (error instanceof CodexLoginProfileRegistryError) throw error;
      throw new CodexLoginProfileRegistryError();
    }
  }

  async updateMetadata(id: string, input: CodexLoginProfileMetadataInput): Promise<CodexLoginProfileRecord> {
    return await this.withMutation(async () => {
      this.assertProfileId(id);
      const keys = input && typeof input === "object" ? Object.keys(input).sort() : [];
      if (keys.length === 0 || keys.some((key) => key !== "enabled" && key !== "label")) {
        throw new CodexLoginProfileRegistryError();
      }
      for (;;) {
        const state = await this.settleState();
        const order = state.profiles.findIndex((entry) => entry.id === id && !entry.cancelingRootName);
        const entry = state.profiles[order];
        if (!entry) throw new CodexLoginProfileRegistryError();
        const label = input.label === undefined ? entry.label : input.label.trim();
        const enabled = input.enabled ?? entry.enabled;
        const updated = { ...entry, label, enabled };
        try {
          assertRegistryEntry(updated);
        } catch {
          throw new CodexLoginProfileRegistryError();
        }
        const committed = await this.tryCommitState(state, {
          ...state,
          profiles: state.profiles.map((candidate) => (candidate.id === id ? updated : candidate)),
        });
        if (committed) return await this.recordFor(updated, order);
      }
    });
  }

  async reorder(ids: readonly string[]): Promise<CodexLoginProfileRecord[]> {
    return await this.withMutation(async () => {
      if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some((id) => !isRegistryProfileId(id))) {
        throw new CodexLoginProfileRegistryError();
      }
      for (;;) {
        const state = await this.settleState();
        if (state.cleanup.length > 0 || state.profiles.some((entry) => entry.cancelingRootName)) {
          throw new CodexLoginProfileRegistryError();
        }
        const byId = new Map(state.profiles.map((entry) => [entry.id, entry]));
        if (ids.length !== state.profiles.length || ids.some((id) => !byId.has(id))) {
          throw new CodexLoginProfileRegistryError();
        }
        const committed = await this.tryCommitState(state, {
          ...state,
          profiles: ids.map((id) => byId.get(id)!),
        });
        if (committed) return await this.recordsFor(committed);
      }
    });
  }
  async confirm(id: string): Promise<CodexLoginProfileRecord> {
    return await this.withMutation(async () => {
      this.assertProfileId(id);
      for (;;) {
        try {
          await this.privatePaths.verifyRoots();
          const state = await this.settleState();
          const entry = state.profiles.find((candidate) => candidate.id === id);
          if (!entry || entry.status !== "pending" || entry.cancelingRootName) {
            throw new CodexLoginProfileRegistryError();
          }
          await this.recordFor(entry);
          const confirmed = { ...entry, status: "confirmed" as const, enabled: true };
          const committed = await this.tryCommitState(state, {
            ...state,
            profiles: state.profiles.map((candidate) => (candidate.id === id ? confirmed : candidate)),
          });
          if (!committed) continue;
          return await this.recordFor(confirmed, state.profiles.indexOf(entry));
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
          await this.privatePaths.verifyRoots();
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
  private assertProfileId(id: string): void {
    if (!isRegistryProfileId(id)) throw new CodexLoginProfileRegistryError();
  }
  private deriveProfileId(rawId: string, namespace: string): string {
    if (!namespace) return rawId;
    return `profile_${createHash("sha256").update(rawId).digest("base64url")}_${namespace}`;
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
    const oldRoot = this.privatePaths.profileRoot(entry.rootName);
    const cancelingRoot = this.privatePaths.profileRoot(entry.cancelingRootName!);
    await this.renamePath(oldRoot, cancelingRoot).catch(() => {});
    const settled = await this.settleState();
    if (settled.profiles.some((candidate) => candidate.id === entry.id) ||
      settled.cleanup.some((candidate) => candidate.id === entry.id)) {
      throw new CodexLoginProfileRegistryError();
    }
  }

  private async tryMoveToCancellationRoot(entry: RegistryEntry): Promise<boolean> {
    const oldRoot = this.privatePaths.profileRoot(entry.rootName);
    const cancelingRoot = this.privatePaths.profileRoot(entry.cancelingRootName!);
    if (await this.privatePaths.privateDirectoryExists(cancelingRoot)) return true;
    if (!(await this.privatePaths.privateDirectoryExists(oldRoot))) return true;
    try {
      await this.renamePath(oldRoot, cancelingRoot);
      return true;
    } catch {
      return await this.privatePaths.privateDirectoryExists(cancelingRoot);
    }
  }
  private async tryCleanup(cleanup: CleanupEntry): Promise<boolean> {
    const targetPath = this.privatePaths.profileRoot(cleanup.name);
    if (cleanup.kind !== "marker") {
      if (await this.privatePaths.privateDirectoryExists(targetPath)) {
        try {
          await this.removePath(targetPath, { recursive: true, force: true });
        } catch {
          return false;
        }
      }
    } else {
      try {
        await this.privatePaths.verifyPrivateFile(targetPath);
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
      verifyPrivateDirectory: async (targetPath) => await this.privatePaths.verifyPrivateDirectory(targetPath),
      verifyPrivateFile: async (targetPath) => await this.privatePaths.verifyPrivateFile(targetPath),
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
      await this.privatePaths.verifyPrivateFile(this.registryPath);
      parsed = JSON.parse(await readFile(this.registryPath, "utf8")) as unknown;
    } catch (error) {
      if (isEnoent(error)) {
        return {
          schemaVersion: 3,
          generation: 0,
          idNamespace: "",
          profiles: [],
          cleanup: [],
        };
      }
      throw error;
    }
    if ([2, 3].includes((parsed as { schemaVersion?: number } | null)?.schemaVersion ?? -1)) {
      throw new CodexLoginProfileRegistryError();
    }
    const profiles = this.parseLegacyProfiles(parsed);
    return {
      schemaVersion: 3,
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
    const profiles = rawProfiles.map((raw, order) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new CodexLoginProfileRegistryError();
      }
      const entry = raw as { id?: unknown; status?: unknown };
      if (typeof entry.id !== "string" || (entry.status !== "pending" && entry.status !== "confirmed")) {
        throw new CodexLoginProfileRegistryError();
      }
      return normalizeRegistryEntry({ id: entry.id, status: entry.status, rootName: entry.id }, order);
    });
    if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) {
      throw new CodexLoginProfileRegistryError();
    }
    return profiles;
  }

  private async readStateFile(filePath: string, expectedGeneration: number): Promise<RegistryState> {
    await this.privatePaths.verifyPrivateFile(filePath);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CodexLoginProfileRegistryError();
    }
    const raw = parsed as Omit<Partial<RegistryState>, "schemaVersion"> & { schemaVersion?: unknown };
    if (
      (raw.schemaVersion !== 2 && raw.schemaVersion !== 3) ||
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
    const profiles = raw.profiles.map(normalizeRegistryEntry);
    const cleanup = raw.cleanup.map((entry) => {
      assertRegistryCleanupEntry(entry);
      return { ...entry };
    });
    if (new Set(profiles.map((entry) => entry.id)).size !== profiles.length) {
      throw new CodexLoginProfileRegistryError();
    }
    return { ...raw, schemaVersion: 3, profiles, cleanup } as RegistryState;
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
    const state: RegistryState = { ...next, schemaVersion: 3, generation };
    const statePath = this.statePath(generation);
    const tempPath = path.join(this.managerRoot, `.registry-state.${randomBytes(12).toString("hex")}.tmp`);
    try {
      await this.privatePaths.writePrivateJsonTemp(tempPath, state);
      try {
        await this.linkPath(tempPath, statePath);
      } catch (error) {
        if (isEexist(error)) return null;
        throw error;
      }
      await syncRegistryDirectory(this.managerRoot, this.platform);
      await this.privatePaths.verifyPrivateFile(statePath);
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

  private async recordsFor(state: RegistryState): Promise<CodexLoginProfileRecord[]> {
    return await Promise.all(state.profiles
      .filter((entry) => !entry.cancelingRootName)
      .map(async (entry) => await this.recordFor(entry, state.profiles.indexOf(entry))));
  }

  private async recordFor(entry: RegistryEntry, order = 0): Promise<CodexLoginProfileRecord> {
    return {
      id: entry.id,
      status: entry.status,
      label: entry.label,
      enabled: entry.enabled,
      order,
      runtimeContext: await this.privatePaths.runtimeContext(entry.rootName),
    };
  }
}
