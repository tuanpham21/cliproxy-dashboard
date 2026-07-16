import { readdir, unlink } from "node:fs/promises";
import path from "node:path";

import type { TerminalRedemptionTombstone } from "./codex-redemption-journal.js";

const TOMBSTONE_NAME = /^terminal-redemption-([A-Za-z0-9_-]{43})\.json$/;

export async function findLatestPublicTombstone(
  rootPath: string,
  now: number,
  readTombstone: (proposalId: string) => Promise<TerminalRedemptionTombstone | null>,
): Promise<TerminalRedemptionTombstone | null> {
  let names: string[];
  try {
    names = await readdir(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
    throw error;
  }
  let latest: TerminalRedemptionTombstone | null = null;
  for (const name of names) {
    const proposalId = name.match(TOMBSTONE_NAME)?.[1];
    if (!proposalId) continue;
    const tombstone = await readTombstone(proposalId);
    if (!tombstone || Date.parse(tombstone.expiresAt) <= now) continue;
    if (!latest || Date.parse(tombstone.createdAt) > Date.parse(latest.createdAt)) latest = tombstone;
  }
  return latest;
}

export async function pruneExpiredPublicTombstones(
  rootPath: string,
  now: number,
  readTombstone: (proposalId: string) => Promise<TerminalRedemptionTombstone | null>,
  syncDirectory: () => Promise<void>,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(rootPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const proposalId = name.match(TOMBSTONE_NAME)?.[1];
    if (!proposalId) continue;
    const tombstone = await readTombstone(proposalId);
    if (!tombstone || Date.parse(tombstone.expiresAt) > now) continue;
    try {
      await unlink(path.join(rootPath, name));
      await syncDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error;
    }
  }
}
