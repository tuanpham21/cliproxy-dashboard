import type { ProxyModelView } from "./types.js";
import { asString, isRecord, parseOptionalInteger } from "./util.js";

export function normalizeModel(raw: unknown): ProxyModelView | null {
  if (!isRecord(raw)) {
    return null;
  }
  const id = asString(raw.id, "").trim();
  if (!id) {
    return null;
  }
  return {
    id,
    created: parseOptionalInteger(raw.created, 0),
    ownedBy: asString(raw.owned_by, ""),
  };
}

export function sortModels(models: ProxyModelView[]): ProxyModelView[] {
  return [...models].sort((left, right) => {
    if (left.id !== right.id) {
      return left.id.localeCompare(right.id);
    }
    if (left.ownedBy !== right.ownedBy) {
      return left.ownedBy.localeCompare(right.ownedBy);
    }
    return right.created - left.created;
  });
}

export async function readProxyModels(
  proxyUrl: string,
  inboundKey: string | null,
): Promise<{ models: ProxyModelView[]; errors: string[] }> {
  if (!inboundKey) {
    return { models: [], errors: ["No inbound proxy key was found in config.yaml"] };
  }
  try {
    const response = await fetch(`${proxyUrl}/v1/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${inboundKey}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      return {
        models: [],
        errors: [`Model list request failed: ${response.status} ${response.statusText}`],
      };
    }
    const parsed = (await response.json()) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
      return { models: [], errors: ["Model list response was not a valid OpenAI model list"] };
    }
    const models = parsed.data
      .map(normalizeModel)
      .filter((model): model is ProxyModelView => model !== null);
    return { models: sortModels(models), errors: [] };
  } catch {
    return { models: [], errors: [`Could not read model list from ${proxyUrl}/v1/models`] };
  }
}
