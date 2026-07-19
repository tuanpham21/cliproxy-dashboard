import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ReorderCodexProfilesInput,
  UpdateCodexProfileMetadataInput,
} from "../shared/codex-profile-observation-types.js";
import { isLoopbackAddress, isLoopbackHost } from "./codex-profile-api.js";
import {
  CodexProfileObservationServiceError,
  type CodexProfileObservationService,
} from "./codex-profile-observation-service.js";
import type { CodexProfileRefreshCoordinator } from "./codex-profile-refresh-coordinator.js";
import type { DashboardOptions } from "./types.js";

export type CodexProfileObservationController = Pick<
  CodexProfileObservationService,
  "list" | "refresh" | "reorder" | "updateMetadata"
>;
export type CodexProfileRefreshController = Pick<CodexProfileRefreshCoordinator, "cancel" | "refreshAll" | "status">;

type JsonResponse = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<Record<string, unknown>>;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;

export async function handleCodexProfileObservationApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  segments: string[],
  options: Pick<DashboardOptions, "host">,
  service: CodexProfileObservationController | undefined,
  refreshService: CodexProfileRefreshController | undefined,
  jsonResponse: JsonResponse,
  readJsonBody: ReadJsonBody,
): Promise<boolean> {
  if (segments[0] !== "api" || segments[1] !== "codex" || segments[2] !== "login-profiles") return false;
  if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
    jsonResponse(res, 403, { code: "codex_profile_observation_unavailable", error: "Codex Login Profiles are available only from a loopback-local dashboard." });
    return true;
  }
  if (!service) return false;
  try {
    if (pathname === "/api/codex/login-profiles/refresh-all" && refreshService) {
      if (method === "GET") {
        jsonResponse(res, 200, refreshService.status());
        return true;
      }
      if (method === "POST") {
        if (Object.keys(await safeBody(req, readJsonBody)).length > 0) throw new CodexProfileObservationRequestError();
        void refreshService.refreshAll("manual").catch(() => {});
        jsonResponse(res, 202, refreshService.status());
        return true;
      }
      if (method === "DELETE") {
        jsonResponse(res, 200, await refreshService.cancel());
        return true;
      }
    }
    if (method === "GET" && pathname === "/api/codex/login-profiles") {
      jsonResponse(res, 200, await service.list());
      return true;
    }
    if (method === "PUT" && pathname === "/api/codex/login-profiles/order") {
      const input = reorderInput(await safeBody(req, readJsonBody));
      jsonResponse(res, 200, await service.reorder(input.profileIds));
      return true;
    }
    const profileId = segments[3];
    if (!profileId || !PROFILE_ID_PATTERN.test(profileId)) return false;
    if (method === "PATCH" && segments.length === 4) {
      jsonResponse(res, 200, await service.updateMetadata(profileId, metadataInput(await safeBody(req, readJsonBody))));
      return true;
    }
    if (method === "POST" && segments.length === 5 && segments[4] === "refresh") {
      if (Object.keys(await safeBody(req, readJsonBody)).length > 0) throw new CodexProfileObservationRequestError();
      jsonResponse(res, 200, await service.refresh(profileId));
      return true;
    }
  } catch (error) {
    respondError(res, error, jsonResponse);
    return true;
  }
  return false;
}

async function safeBody(req: IncomingMessage, readJsonBody: ReadJsonBody): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req);
  } catch {
    throw new CodexProfileObservationRequestError();
  }
}

function metadataInput(body: Record<string, unknown>): UpdateCodexProfileMetadataInput {
  const keys = Object.keys(body).sort();
  if (keys.length === 0 || keys.some((key) => key !== "enabled" && key !== "label") ||
    (body.enabled !== undefined && typeof body.enabled !== "boolean") ||
    (body.label !== undefined && (typeof body.label !== "string" || !body.label.trim() ||
      Buffer.byteLength(body.label.trim(), "utf8") > 80))) {
    throw new CodexProfileObservationRequestError();
  }
  return {
    ...(body.label === undefined ? {} : { label: (body.label as string).trim() }),
    ...(body.enabled === undefined ? {} : { enabled: body.enabled as boolean }),
  };
}

function reorderInput(body: Record<string, unknown>): ReorderCodexProfilesInput {
  if (Object.keys(body).join(",") !== "profileIds" || !Array.isArray(body.profileIds) ||
    new Set(body.profileIds).size !== body.profileIds.length ||
    body.profileIds.some((profileId) => typeof profileId !== "string" || !PROFILE_ID_PATTERN.test(profileId))) {
    throw new CodexProfileObservationRequestError();
  }
  return { profileIds: [...body.profileIds] };
}

class CodexProfileObservationRequestError extends Error {}

function respondError(res: ServerResponse, error: unknown, jsonResponse: JsonResponse): void {
  if (error instanceof CodexProfileObservationRequestError) {
    jsonResponse(res, 400, { code: "invalid-profile-observation-request", error: "Valid Codex Login Profile fields are required." });
    return;
  }
  if (error instanceof CodexProfileObservationServiceError) {
    const status = error.code === "identity-changed" || error.code === "profile-not-refreshable" ? 409 : 503;
    const message = error.code === "identity-changed"
      ? "The Codex app account changed. Confirm the intended account before refreshing again."
      : error.code === "profile-not-refreshable"
        ? "This Codex Login Profile cannot be refreshed."
        : "Couldn’t refresh this Codex Login Profile.";
    jsonResponse(res, status, { code: error.code, error: message });
    return;
  }
  jsonResponse(res, 503, { code: "profile-observation-unavailable", error: "Couldn’t load Codex Login Profiles." });
}
