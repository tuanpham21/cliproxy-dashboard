import { open, readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type RegistryCleanupEntry =
  | { id: string; kind: "active-root"; name: string }
  | { id: string; kind: "canceling-root"; name: string }
  | { id: string; kind: "marker"; name: string };

export type RegistryEntry = {
  id: string;
  status: "pending" | "confirmed";
  rootName: string;
  label: string;
  enabled: boolean;
  cancelingRootName?: string;
};

type LegacyCancellationArtifactDependencies = {
  profilesRoot: string;
  verifyPrivateDirectory: (targetPath: string) => Promise<void>;
  verifyPrivateFile: (targetPath: string) => Promise<void>;
};

const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;
const ACTIVE_ROOT_PATTERN = /^\.([A-Za-z0-9_-]{24,80})\.([a-f0-9]{24})\.profile$/;
const CANCELING_ROOT_PATTERN = /^\.([A-Za-z0-9_-]{24,80})\.([a-f0-9]{24})\.canceling$/;
const CANCELED_PROFILE_MARKER_PATTERN = /^\.([A-Za-z0-9_-]{24,80})\.canceled\.json$/;

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function cancelingRootProfileId(name: string): string | undefined {
  return CANCELING_ROOT_PATTERN.exec(name)?.[1];
}

export function isRegistryProfileId(id: string): boolean {
  return PROFILE_ID_PATTERN.test(id);
}

export function defaultRegistryProfileLabel(order: number): string {
  return `Codex Login Profile ${order + 1}`;
}

export function normalizeRegistryEntry(entry: unknown, order: number): RegistryEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Invalid registry entry.");
  }
  const candidate = entry as Partial<RegistryEntry>;
  const normalized: RegistryEntry = {
    id: candidate.id as string,
    status: candidate.status as RegistryEntry["status"],
    rootName: candidate.rootName as string,
    label: candidate.label ?? defaultRegistryProfileLabel(order),
    enabled: candidate.enabled ?? candidate.status === "confirmed",
    ...(candidate.cancelingRootName === undefined ? {} : { cancelingRootName: candidate.cancelingRootName }),
  };
  assertRegistryEntry(normalized);
  return normalized;
}

export function assertRegistryEntry(entry: unknown): asserts entry is RegistryEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Invalid registry entry.");
  }
  const candidate = entry as Partial<RegistryEntry>;
  if (
    typeof candidate.id !== "string" ||
    !isRegistryProfileId(candidate.id) ||
    (candidate.status !== "pending" && candidate.status !== "confirmed") ||
    typeof candidate.rootName !== "string" ||
    typeof candidate.label !== "string" ||
    !candidate.label.trim() ||
    candidate.label !== candidate.label.trim() ||
    Buffer.byteLength(candidate.label, "utf8") > 80 ||
    typeof candidate.enabled !== "boolean" ||
    (candidate.status === "pending" && candidate.enabled)
  ) {
    throw new Error("Invalid registry entry.");
  }
  const activeId = candidate.rootName === candidate.id
    ? candidate.id
    : ACTIVE_ROOT_PATTERN.exec(candidate.rootName)?.[1];
  if (
    activeId !== candidate.id ||
    (candidate.cancelingRootName !== undefined &&
      cancelingRootProfileId(candidate.cancelingRootName) !== candidate.id)
  ) {
    throw new Error("Invalid registry entry.");
  }
}

export async function syncRegistryDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function assertRegistryCleanupEntry(entry: unknown): asserts entry is RegistryCleanupEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("Invalid registry cleanup entry.");
  }
  const candidate = entry as Partial<RegistryCleanupEntry>;
  if (
    typeof candidate.id !== "string" ||
    !PROFILE_ID_PATTERN.test(candidate.id) ||
    typeof candidate.name !== "string"
  ) {
    throw new Error("Invalid registry cleanup entry.");
  }
  if (candidate.kind === "active-root" && candidate.name === candidate.id) {
    return;
  }
  if (candidate.kind === "canceling-root" && cancelingRootProfileId(candidate.name) === candidate.id) {
    return;
  }
  if (candidate.kind === "marker" && CANCELED_PROFILE_MARKER_PATTERN.exec(candidate.name)?.[1] === candidate.id) {
    return;
  }
  throw new Error("Invalid registry cleanup entry.");
}

export async function discoverLegacyCancellationArtifacts(
  dependencies: LegacyCancellationArtifactDependencies,
): Promise<{ canceledIds: Set<string>; cleanup: RegistryCleanupEntry[] } | null> {
  const canceledIds = new Set<string>();
  const cleanup: RegistryCleanupEntry[] = [];
  for (const name of await readdir(dependencies.profilesRoot)) {
    const cancelingId = cancelingRootProfileId(name);
    if (cancelingId) {
      try {
        await dependencies.verifyPrivateDirectory(path.join(dependencies.profilesRoot, name));
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
      canceledIds.add(cancelingId);
      cleanup.push({ id: cancelingId, kind: "canceling-root", name });
      continue;
    }
    const markerId = CANCELED_PROFILE_MARKER_PATTERN.exec(name)?.[1];
    if (!markerId) continue;
    const markerPath = path.join(dependencies.profilesRoot, name);
    let parsed: unknown;
    try {
      await dependencies.verifyPrivateFile(markerPath);
      parsed = JSON.parse(await readFile(markerPath, "utf8")) as unknown;
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
    const marker = parsed as { schemaVersion?: unknown; id?: unknown; cancelingRootName?: unknown } | null;
    if (
      !marker ||
      typeof marker !== "object" ||
      Array.isArray(marker) ||
      marker.schemaVersion !== 1 ||
      marker.id !== markerId ||
      typeof marker.cancelingRootName !== "string" ||
      cancelingRootProfileId(marker.cancelingRootName) !== markerId
    ) {
      throw new Error("Invalid legacy cancellation marker.");
    }
    canceledIds.add(markerId);
    cleanup.push({ id: markerId, kind: "marker", name });
  }
  for (const id of canceledIds) {
    cleanup.push({ id, kind: "active-root", name: id });
  }
  return { canceledIds, cleanup };
}
