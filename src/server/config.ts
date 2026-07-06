import { readFile } from "node:fs/promises";
import YAML from "yaml";

import { DEFAULT_AUTH_DIR, DEFAULT_PROXY_PORT } from "./constants.js";
import { atomicWriteText } from "./files.js";
import type { ProxyConfig, PublicProxyConfig } from "./types.js";
import { asBoolean, asString, isRecord, parseOptionalInteger } from "./util.js";

export function chooseInboundKey(raw: Record<string, unknown> | null): string | null {
  const apiKeys = raw && Array.isArray(raw["api-keys"]) ? raw["api-keys"] : [];
  const keys = apiKeys.filter((value): value is string => typeof value === "string");
  const codex = keys.find((key) => key.toLowerCase().includes("codex"));
  return codex ?? keys[0] ?? null;
}

export function normalizeConfig(raw: unknown, pathName: string): ProxyConfig | null {
  if (!isRecord(raw)) {
    return null;
  }
  const routing = isRecord(raw.routing) ? raw.routing : null;
  const apiKeys = Array.isArray(raw["api-keys"])
    ? raw["api-keys"].filter((value): value is string => typeof value === "string")
    : [];
  return {
    raw,
    path: pathName,
    port: parseOptionalInteger(raw.port, DEFAULT_PROXY_PORT),
    authDir: asString(raw["auth-dir"], DEFAULT_AUTH_DIR),
    routingStrategy: asString(routing?.strategy, "fill-first"),
    sessionAffinity: asBoolean(routing?.["session-affinity"], false),
    apiKeys,
  };
}

export function publicConfig(config: ProxyConfig | null): PublicProxyConfig | null {
  if (!config) {
    return null;
  }
  const { raw: _raw, apiKeys, ...publicConfigValue } = config;
  return {
    ...publicConfigValue,
    apiKeysConfigured: apiKeys.length > 0,
    apiKeyCount: apiKeys.length,
  };
}

export async function readConfig(configPath: string): Promise<ProxyConfig | null> {
  try {
    const text = await readFile(configPath, "utf8");
    const parsed = YAML.parse(text) as unknown;
    return normalizeConfig(parsed, configPath);
  } catch {
    return null;
  }
}

export async function setRoutingConfig(
  configPath: string,
  next: { strategy: string; sessionAffinity: boolean },
): Promise<ProxyConfig | null> {
  const existing = await readConfig(configPath);
  if (!existing) {
    throw new Error(`Unable to read proxy config: ${configPath}`);
  }
  const raw = structuredClone(existing.raw) as Record<string, unknown>;
  const routing = isRecord(raw.routing) ? raw.routing : {};
  routing.strategy = next.strategy;
  routing["session-affinity"] = next.sessionAffinity;
  raw.routing = routing;
  await atomicWriteText(configPath, `${YAML.stringify(raw).trimEnd()}\n`);
  return normalizeConfig(raw, configPath);
}
