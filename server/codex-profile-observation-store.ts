import { randomBytes } from "node:crypto";
import { link, lstat, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  CodexProfileObservationFreshness,
  CodexProfileObservationSnapshot,
} from "../shared/codex-profile-observation-types.js";
import type { CodexAccountUsageWindow } from "../shared/types.js";
import { CodexLoginProfilePrivatePaths } from "./codex-login-profile-private-paths.js";
import { isRegistryProfileId, syncRegistryDirectory } from "./codex-login-profile-registry-migration.js";
import type { WindowsPrivatePathSecurity } from "./codex-redemption-windows-security.js";

export type { CodexProfileObservationFreshness, CodexProfileObservationSnapshot };
export type StoredCodexProfileObservation = Readonly<{
  generation: number;
  snapshot: CodexProfileObservationSnapshot;
}>;
export type ListedCodexProfileObservation = StoredCodexProfileObservation & Readonly<{ profileId: string }>;

type ObservationState = {
  schemaVersion: 1;
  profileId: string;
  generation: number;
  snapshot: CodexProfileObservationSnapshot;
};
type CodexProfileObservationStoreDependencies = {
  managerRoot: string;
  platform?: NodeJS.Platform;
  windowsSecurity?: WindowsPrivatePathSecurity;
  linkPath?: typeof link;
  removePath?: (targetPath: string) => Promise<void>;
};

const OBSERVATION_FILE_PATTERN = /^\.([A-Za-z0-9_-]{24,80})\.observation\.([1-9][0-9]*)\.json$/;
const OBSERVATION_TEMP_PATTERN = /^\.observation\.[a-f0-9]{24}\.tmp$/;
const OBSERVATION_TEMP_STALE_MS = 60_000;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "EEXIST";
}

function exactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).sort().join(",") === [...expected].sort().join(",");
}

function validIso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validUsageWindow(value: unknown): value is CodexAccountUsageWindow | null {
  if (value === null) return true;
  if (!exactKeys(value, ["durationMinutes", "resetsAt", "usedPercent"])) return false;
  const usedPercent = value.usedPercent;
  const durationMinutes = value.durationMinutes;
  return (usedPercent === null || (typeof usedPercent === "number" && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100)) &&
    (durationMinutes === null || (typeof durationMinutes === "number" && Number.isSafeInteger(durationMinutes) && durationMinutes >= 0)) &&
    (value.resetsAt === null || validIso(value.resetsAt));
}

function assertSnapshot(value: unknown): asserts value is CodexProfileObservationSnapshot {
  if (!exactKeys(value, ["account", "freshness", "observedAt", "resetCredits", "runtimeVersion", "usage"]) ||
    !exactKeys(value.account, ["email", "plan"]) ||
    typeof value.account.email !== "string" || value.account.email !== value.account.email.trim() ||
    !value.account.email || Buffer.byteLength(value.account.email, "utf8") > 320 ||
    typeof value.account.plan !== "string" || !value.account.plan || value.account.plan === "unknown" ||
    Buffer.byteLength(value.account.plan, "utf8") > 80 ||
    !validIso(value.observedAt) || typeof value.runtimeVersion !== "string" || !value.runtimeVersion ||
    Buffer.byteLength(value.runtimeVersion, "utf8") > 200 ||
    !exactKeys(value.usage, ["primary", "secondary"]) ||
    !validUsageWindow(value.usage.primary) || !validUsageWindow(value.usage.secondary) ||
    !exactKeys(value.resetCredits, ["availableCount"]) ||
    !(value.resetCredits.availableCount === null ||
      (typeof value.resetCredits.availableCount === "number" &&
        Number.isSafeInteger(value.resetCredits.availableCount) && value.resetCredits.availableCount >= 0)) ||
    (value.freshness !== "fresh" && value.freshness !== "latest-known" && value.freshness !== "identity-changed")) {
    throw new CodexProfileObservationStoreError("invalid-snapshot");
  }
}

function cloneSnapshot(snapshot: CodexProfileObservationSnapshot): CodexProfileObservationSnapshot {
  return {
    account: { ...snapshot.account },
    observedAt: snapshot.observedAt,
    usage: {
      primary: snapshot.usage.primary ? { ...snapshot.usage.primary } : null,
      secondary: snapshot.usage.secondary ? { ...snapshot.usage.secondary } : null,
    },
    resetCredits: { ...snapshot.resetCredits },
    runtimeVersion: snapshot.runtimeVersion,
    freshness: snapshot.freshness,
  };
}

export type CodexProfileObservationStoreErrorCode = "invalid-snapshot" | "stale-generation" | "unavailable";

export class CodexProfileObservationStoreError extends Error {
  constructor(readonly code: CodexProfileObservationStoreErrorCode) {
    super("Codex Profile Observation Store unavailable.");
    this.name = "CodexProfileObservationStoreError";
  }
}

export class CodexProfileObservationStore {
  private readonly privatePaths: CodexLoginProfilePrivatePaths;
  private readonly observationsRoot: string;
  private readonly linkPath: typeof link;
  private readonly removePath: (targetPath: string) => Promise<void>;
  private readonly freshGenerations = new Map<string, number>();

  constructor(dependencies: CodexProfileObservationStoreDependencies) {
    this.privatePaths = new CodexLoginProfilePrivatePaths(dependencies);
    this.observationsRoot = path.join(this.privatePaths.managerRoot, "observations");
    this.linkPath = dependencies.linkPath ?? link;
    this.removePath = dependencies.removePath ?? (async (targetPath) => await rm(targetPath, { force: true }));
  }

  async get(profileId: string): Promise<StoredCodexProfileObservation | null> {
    this.assertProfileId(profileId);
    try {
      await this.ensureRoot();
      const state = await this.load(profileId);
      return state ? this.publicObservation(state) : null;
    } catch (error) {
      if (error instanceof CodexProfileObservationStoreError) throw error;
      throw new CodexProfileObservationStoreError("unavailable");
    }
  }

  async list(profileIds: readonly string[]): Promise<ListedCodexProfileObservation[]> {
    if (!Array.isArray(profileIds) || new Set(profileIds).size !== profileIds.length) {
      throw new CodexProfileObservationStoreError("unavailable");
    }
    profileIds.forEach((profileId) => this.assertProfileId(profileId));
    try {
      await this.ensureRoot();
      const requested = new Set(profileIds);
      const latest = new Map<string, number>();
      for (const name of await readdir(this.observationsRoot)) {
        const match = OBSERVATION_FILE_PATTERN.exec(name);
        if (!match || !requested.has(match[1]!)) continue;
        const generation = Number(match[2]);
        if (Number.isSafeInteger(generation) && generation > (latest.get(match[1]!) ?? 0)) {
          latest.set(match[1]!, generation);
        }
      }
      const observations = await Promise.all(profileIds.map(async (profileId) => {
        const generation = latest.get(profileId);
        if (generation === undefined) return null;
        return { profileId, ...this.publicObservation(await this.readState(profileId, generation)) };
      }));
      return observations.filter((value): value is ListedCodexProfileObservation => value !== null);
    } catch (error) {
      if (error instanceof CodexProfileObservationStoreError) throw error;
      throw new CodexProfileObservationStoreError("unavailable");
    }
  }

  async reconcile(profileIds: readonly string[]): Promise<void> {
    if (!Array.isArray(profileIds) || new Set(profileIds).size !== profileIds.length) {
      throw new CodexProfileObservationStoreError("unavailable");
    }
    profileIds.forEach((profileId) => this.assertProfileId(profileId));
    try {
      await this.ensureRoot();
      const retained = new Set(profileIds);
      let removed = false;
      for (const name of await readdir(this.observationsRoot)) {
        const match = OBSERVATION_FILE_PATTERN.exec(name);
        if (OBSERVATION_TEMP_PATTERN.test(name)) {
          if (!(await this.isStaleTemp(name))) continue;
        } else if (!match || retained.has(match[1]!)) {
          continue;
        }
        await this.removePath(path.join(this.observationsRoot, name));
        if (match) this.freshGenerations.delete(match[1]!);
        removed = true;
      }
      for (const profileId of profileIds) await this.cleanup(profileId);
      if (removed) await syncRegistryDirectory(this.observationsRoot, this.privatePaths.platform);
      for (const name of await readdir(this.observationsRoot)) {
        const match = OBSERVATION_FILE_PATTERN.exec(name);
        if ((OBSERVATION_TEMP_PATTERN.test(name) && await this.isStaleTemp(name)) ||
          (match && !retained.has(match[1]!))) {
          throw new CodexProfileObservationStoreError("unavailable");
        }
      }
    } catch (error) {
      if (error instanceof CodexProfileObservationStoreError) throw error;
      throw new CodexProfileObservationStoreError("unavailable");
    }
  }

  async remove(profileId: string): Promise<void> {
    this.assertProfileId(profileId);
    try {
      await this.ensureRoot();
      let removed = false;
      for (const generation of await this.generations(profileId)) {
        await this.removePath(this.statePath(profileId, generation));
        removed = true;
      }
      if ((await this.generations(profileId)).length > 0) {
        throw new CodexProfileObservationStoreError("unavailable");
      }
      this.freshGenerations.delete(profileId);
      if (removed) await syncRegistryDirectory(this.observationsRoot, this.privatePaths.platform);
    } catch (error) {
      if (error instanceof CodexProfileObservationStoreError) throw error;
      throw new CodexProfileObservationStoreError("unavailable");
    }
  }

  async replace(
    profileId: string,
    expectedGeneration: number | null,
    snapshot: CodexProfileObservationSnapshot,
  ): Promise<StoredCodexProfileObservation> {
    this.assertProfileId(profileId);
    assertSnapshot(snapshot);
    try {
      await this.ensureRoot();
      await this.cleanup(profileId);
      const current = await this.load(profileId);
      if ((current?.generation ?? null) !== expectedGeneration) {
        throw new CodexProfileObservationStoreError("stale-generation");
      }
      const generation = (expectedGeneration ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw new CodexProfileObservationStoreError("unavailable");
      const state: ObservationState = {
        schemaVersion: 1,
        profileId,
        generation,
        snapshot: cloneSnapshot(snapshot),
      };
      const statePath = this.statePath(profileId, generation);
      const tempPath = path.join(this.observationsRoot, `.observation.${randomBytes(12).toString("hex")}.tmp`);
      try {
        await this.privatePaths.writePrivateJsonTemp(tempPath, state);
        try {
          await this.linkPath(tempPath, statePath);
        } catch (error) {
          if (isEexist(error)) throw new CodexProfileObservationStoreError("stale-generation");
          throw error;
        }
        await syncRegistryDirectory(this.observationsRoot, this.privatePaths.platform);
        await this.privatePaths.verifyPrivateFile(statePath);
        if ((await this.generations(profileId)).at(-1) !== generation) {
          throw new CodexProfileObservationStoreError("stale-generation");
        }
        this.freshGenerations.set(profileId, generation);
        await this.cleanup(profileId);
        if ((await this.generations(profileId)).at(-1) !== generation) {
          throw new CodexProfileObservationStoreError("stale-generation");
        }
        const result = this.publicObservation(state);
        return result;
      } finally {
        await this.removePath(tempPath);
      }
    } catch (error) {
      if (error instanceof CodexProfileObservationStoreError) throw error;
      throw new CodexProfileObservationStoreError("unavailable");
    }
  }

  private async ensureRoot(): Promise<void> {
    await this.privatePaths.ensureRoots();
    await this.privatePaths.ensurePrivateDirectory(this.observationsRoot);
  }

  private assertProfileId(profileId: string): void {
    if (!isRegistryProfileId(profileId)) throw new CodexProfileObservationStoreError("unavailable");
  }

  private async load(profileId: string): Promise<ObservationState | null> {
    for (;;) {
      const generation = (await this.generations(profileId)).at(-1);
      if (generation === undefined) return null;
      try {
        return await this.readState(profileId, generation);
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
    }
  }

  private async readState(profileId: string, generation: number): Promise<ObservationState> {
    const statePath = this.statePath(profileId, generation);
    await this.privatePaths.verifyPrivateFile(statePath);
    return this.parseState(JSON.parse(await readFile(statePath, "utf8")) as unknown, profileId, generation);
  }

  private parseState(value: unknown, profileId: string, generation: number): ObservationState {
    if (!exactKeys(value, ["generation", "profileId", "schemaVersion", "snapshot"]) ||
      value.schemaVersion !== 1 || value.profileId !== profileId || value.generation !== generation ||
      !Number.isSafeInteger(value.generation) || value.generation < 1) {
      throw new CodexProfileObservationStoreError("unavailable");
    }
    assertSnapshot(value.snapshot);
    return { schemaVersion: 1, profileId, generation, snapshot: cloneSnapshot(value.snapshot) };
  }

  private publicObservation(state: ObservationState): StoredCodexProfileObservation {
    const snapshot = cloneSnapshot(state.snapshot);
    if (snapshot.freshness === "fresh" && this.freshGenerations.get(state.profileId) !== state.generation) {
      return { generation: state.generation, snapshot: { ...snapshot, freshness: "latest-known" } };
    }
    return { generation: state.generation, snapshot };
  }

  private async generations(profileId: string): Promise<number[]> {
    return (await readdir(this.observationsRoot))
      .map((name) => OBSERVATION_FILE_PATTERN.exec(name))
      .filter((match): match is RegExpExecArray => match?.[1] === profileId)
      .map((match) => Number(match[2]))
      .filter((generation) => Number.isSafeInteger(generation))
      .sort((left, right) => left - right);
  }

  private statePath(profileId: string, generation: number): string {
    return path.join(this.observationsRoot, `.${profileId}.observation.${generation}.json`);
  }

  private async isStaleTemp(name: string): Promise<boolean> {
    try {
      const metadata = await lstat(path.join(this.observationsRoot, name));
      return Date.now() - metadata.mtimeMs >= OBSERVATION_TEMP_STALE_MS;
    } catch (error) {
      if (isEnoent(error)) return false;
      throw error;
    }
  }

  private async cleanup(profileId: string): Promise<void> {
    const latest = (await this.generations(profileId)).at(-1);
    if (latest === undefined) return;
    let removed = false;
    for (const generation of await this.generations(profileId)) {
      if (generation >= latest) continue;
      try {
        await this.removePath(this.statePath(profileId, generation));
        removed = true;
      } catch {}
    }
    if (removed) await syncRegistryDirectory(this.observationsRoot, this.privatePaths.platform);
    if ((await this.generations(profileId)).length > 1) {
      throw new CodexProfileObservationStoreError("unavailable");
    }
  }
}
