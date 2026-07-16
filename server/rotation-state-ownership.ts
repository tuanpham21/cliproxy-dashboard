import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

type PersistedOwnership = {
  pid: number;
  token: string;
  acquiredAt: string;
};

export type RotationStateOwnership = {
  lockPath: string;
  token: string;
};

function parseOwnership(value: string): PersistedOwnership | null {
  try {
    const parsed = JSON.parse(value) as Partial<PersistedOwnership>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return null;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
    if (typeof parsed.acquiredAt !== "string" || !Number.isFinite(Date.parse(parsed.acquiredAt))) return null;
    return parsed as PersistedOwnership;
  } catch {
    return null;
  }
}

export async function acquireRotationStateOwnership(statePath: string): Promise<RotationStateOwnership> {
  await mkdir(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`rotation controller singleton ownership already held or requires stale-lock recovery: ${statePath}`);
    }
    throw error;
  }

  const token = randomUUID();
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`, "utf8");
    await handle.sync();
    return { lockPath, token };
  } catch (error) {
    try {
      await unlink(lockPath);
    } catch {
      // Best effort: acquisition never returns when ownership record cannot be persisted.
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export function releaseRotationStateOwnership(ownership: RotationStateOwnership): void {
  try {
    const current = parseOwnership(readFileSync(ownership.lockPath, "utf8"));
    if (current?.token === ownership.token) unlinkSync(ownership.lockPath);
  } catch {
    // Ownership cleanup is best effort; a leftover lock requires explicit local recovery.
  }
}
