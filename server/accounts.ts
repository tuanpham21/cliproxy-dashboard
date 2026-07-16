import { access, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_BACKUP_PRIORITY, DEFAULT_PRIORITY } from "./constants.js";
import { atomicWriteText, backupFile, readJsonObject } from "./files.js";
import { resolveAccountPath } from "./paths.js";
import type { AccountView, PublicAccountView } from "./types.js";
import { asBoolean, asString, emptyPublicQuotaSnapshot, isRecord, parseOptionalInteger } from "./util.js";

export function inferPlanFromFileName(fileName: string): string {
  const stem = fileName.replace(/\.json(?:\.disabled)?$/, "");
  const parts = stem.split("-");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

export function parseJwtExp(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length === 3) {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (typeof payload.exp === "number") {
        return new Date(payload.exp * 1000).toISOString();
      }
    }
  } catch {}
  return null;
}

export function normalizeAccount(filePath: string, raw: Record<string, unknown>, credentialFileMtimeMs?: number): AccountView {
  const fileName = path.basename(filePath);
  const disabled = asBoolean(raw.disabled, false) || fileName.endsWith(".disabled");
  const priority =
    typeof raw.priority === "number" && Number.isInteger(raw.priority)
      ? raw.priority
      : DEFAULT_PRIORITY;
  const explicitPriority = typeof raw.priority === "number" && Number.isInteger(raw.priority);
  const accountId = asString(raw.account_id, "");
  const validityStatusRaw = asString(raw.validity_status, "unverified");
  const validityStatus = (validityStatusRaw === "valid" || validityStatusRaw === "invalid" ? validityStatusRaw : "unverified") as "valid" | "invalid" | "unverified";

    let subscriptionPlan: string | undefined;
    let subscriptionActiveUntil: string | undefined;
    let subscriptionLastChecked: string | undefined;

  const idToken = asString(raw.id_token, "");
  if (idToken) {
    try {
      const parts = idToken.split(".");
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (isRecord(payload)) {
            const openAiAuth = payload["https://api.openai.com/auth"];
            if (isRecord(openAiAuth)) {
              subscriptionPlan = asString(openAiAuth.chatgpt_plan_type, "") || undefined;
              subscriptionActiveUntil = asString(openAiAuth.chatgpt_subscription_active_until, "") || undefined;
              subscriptionLastChecked = asString(openAiAuth.chatgpt_subscription_last_checked, "") || undefined;
            }
          }
        }
    } catch {}
  }

  return {
    fileName,
    path: filePath,
    email: asString(raw.email, fileName.replace(/^codex-/, "")),
    priority,
    explicitPriority,
    disabled,
    note: asString(raw.note, ""),
    accountId,
    accountIdShort: accountId ? accountId.slice(0, 8) : "",
    type: asString(raw.type, ""),
    plan: inferPlanFromFileName(fileName),
    expired: asString(raw.expired, ""),
    lastRefresh: asString(raw.last_refresh, ""),
      validityStatus,
      validationError: asString(raw.validation_error, ""),
      subscriptionPlan,
      subscriptionActiveUntil,
      subscriptionLastChecked,
      credentialFileMtimeMs,
      raw,
    };
  }

export function publicAccount(account: AccountView, quota = emptyPublicQuotaSnapshot(), proxyAccountKey?: string): PublicAccountView {
  const { raw: _raw, credentialFileMtimeMs: _credentialFileMtimeMs, ...publicAccountValue } = account;
  return {
      ...publicAccountValue,
      ...(proxyAccountKey ? { proxyAccountKey } : {}),
      quota,
  };
}

export function sortAccounts(accounts: AccountView[]): AccountView[] {
  return [...accounts].sort((left, right) => {
    if (left.disabled !== right.disabled) {
      return Number(left.disabled) - Number(right.disabled);
    }
    if (right.priority !== left.priority) {
      return right.priority - left.priority;
    }
    return left.fileName.localeCompare(right.fileName);
  });
}

export async function readAccounts(
  authDir: string,
): Promise<{ accounts: AccountView[]; errors: string[] }> {
  const errors: string[] = [];
  try {
    await access(authDir);
  } catch {
    return { accounts: [], errors };
  }

  const entries = await readdir(authDir, { withFileTypes: true });
  const accounts: AccountView[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!/^codex-.*\.json(?:\.disabled)?$/.test(entry.name)) {
      continue;
    }
    const filePath = path.join(authDir, entry.name);
    const raw = await readJsonObject(filePath);
    if (!raw) {
      errors.push(`Could not read ${entry.name}`);
      continue;
    }
      const stats = await stat(filePath).catch(() => null);
      accounts.push(normalizeAccount(filePath, raw, stats?.mtimeMs));
  }
  return { accounts: sortAccounts(accounts), errors };
}

export async function mutateAccountFile(
  authDir: string,
  backupRoot: string,
  fileName: string,
  mutator: (raw: Record<string, unknown>) => void,
): Promise<AccountView> {
  const filePath = resolveAccountPath(authDir, fileName);
  const raw = await readJsonObject(filePath);
  if (!raw) {
    throw new Error(`Unable to read account file: ${fileName}`);
  }
  const next = structuredClone(raw) as Record<string, unknown>;
  mutator(next);
  await backupFile(filePath, backupRoot);

  const shouldBeDisabled = Boolean(next.disabled);
  const currentlyDisabled = fileName.endsWith(".disabled");
  let targetFileName = fileName;
  if (shouldBeDisabled && !currentlyDisabled) {
    targetFileName = `${fileName}.disabled`;
  } else if (!shouldBeDisabled && currentlyDisabled) {
    targetFileName = fileName.replace(/\.disabled$/, "");
  }

  const targetPath = resolveAccountPath(authDir, targetFileName);
  await atomicWriteText(targetPath, `${JSON.stringify(next, null, 2)}\n`);

  if (targetPath !== filePath) {
    try {
      await unlink(filePath);
    } catch {
      // Ignore
    }
  }

    const stats = await stat(targetPath).catch(() => null);
    return normalizeAccount(targetPath, next, stats?.mtimeMs);
}

export async function setAccountPatch(
  authDir: string,
  backupRoot: string,
  fileName: string,
  patch: { priority?: number | null; disabled?: boolean | null; note?: string | null },
): Promise<AccountView> {
  return await mutateAccountFile(authDir, backupRoot, fileName, (raw) => {
    if (patch.priority === null) {
      delete raw.priority;
    } else if (typeof patch.priority === "number" && Number.isInteger(patch.priority)) {
      raw.priority = patch.priority;
    }
    if (typeof patch.disabled === "boolean") {
      raw.disabled = patch.disabled;
    }
    if (patch.note === null) {
      delete raw.note;
    } else if (typeof patch.note === "string") {
      const trimmed = patch.note.trim();
      if (trimmed) {
        raw.note = trimmed;
      } else {
        delete raw.note;
      }
    }
  });
}

export async function promotePrimary(
  authDir: string,
  backupRoot: string,
  targetFileName: string,
  backupPriority = DEFAULT_BACKUP_PRIORITY,
): Promise<void> {
  const entries = await readAccounts(authDir);
  const targetPath = resolveAccountPath(authDir, targetFileName);
  const targetName = path.basename(targetPath);
  const target = entries.accounts.find((account) => account.fileName === targetName);
  if (!target) {
    throw new Error(`Unknown account: ${targetFileName}`);
  }
  const targetPriority = Math.max(DEFAULT_PRIORITY, backupPriority + 1);
  for (const account of entries.accounts) {
    if (account.fileName === targetName) {
      await setAccountPatch(authDir, backupRoot, account.fileName, {
        priority: targetPriority,
        disabled: false,
        note: "primary",
      });
      continue;
    }
    await setAccountPatch(authDir, backupRoot, account.fileName, {
      priority: backupPriority,
      note: account.note || "backup",
    });
  }
}
