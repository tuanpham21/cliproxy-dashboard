import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { isRecord } from "./util.js";

export async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const text = await readFile(filePath, "utf8");
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function backupFile(filePath: string, backupRoot: string): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(backupRoot, stamp);
  await mkdir(targetDir, { recursive: true });
  await copyFile(filePath, path.join(targetDir, path.basename(filePath)));
}

export async function atomicWriteText(filePath: string, text: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, text, "utf8");
  await rename(tempPath, filePath);
}
