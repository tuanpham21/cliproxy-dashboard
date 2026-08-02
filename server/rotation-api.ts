import type { IncomingMessage, ServerResponse } from "node:http";

import type { RotationCoordinator } from "./rotation-coordinator.js";
import type { RotationMode, RotationPoolMode } from "./rotation-types.js";

function jsonResponse(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`${JSON.stringify(payload)}\n`);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON object body required");
  return parsed as Record<string, unknown>;
}

export async function coordinateManualRoutingAction(coordinator: RotationCoordinator | null | undefined, message: string): Promise<void> {
  if (coordinator === null) throw new Error("Rotation coordinator startup is incomplete");
  if (!coordinator) return;
  const state = await coordinator.enterManualHold(message);
  if (state.lifecycle === "paused" || state.lifecycle === "recovery-required") {
    throw new Error(state.pauseMessage ?? "Rotation controller could not enter Manual Hold");
  }
}

export async function handleRotationApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  segments: string[],
  coordinator: RotationCoordinator | null | undefined,
): Promise<boolean> {
  if (!pathname.startsWith("/api/rotation")) return false;
  if (!coordinator) {
    jsonResponse(res, 503, { error: "Rotation coordinator unavailable" });
    return true;
  }
  try {
    if (method === "GET" && pathname === "/api/rotation") {
      jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
      return true;
    }
    if (method === "POST" && pathname === "/api/rotation/mode") {
      const body = await readJsonBody(req);
      const mode = body.mode;
      if (mode !== "off" && mode !== "shadow" && mode !== "active") throw new Error("mode must be off, shadow, or active");
      await coordinator.setMode(mode as RotationMode);
      jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
      return true;
    }
    if (method === "POST" && pathname === "/api/rotation/pool-mode") {
      const body = await readJsonBody(req);
      const poolMode = body.poolMode;
      if (poolMode !== "manual") {
        throw new Error("all-enabled-codex pool mode is no longer supported. Re-add accounts explicitly with exclusivity attestation.");
      }
      await coordinator.setPoolMode("manual");
      jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
      return true;
    }
    if (method === "POST" && pathname === "/api/rotation/pause") {
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "Operator paused Quota-Balanced Rotation";
      await coordinator.pause(message);
      jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
      return true;
    }
      if (method === "POST" && pathname === "/api/rotation/resume") {
        await coordinator.resume();
        jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
        return true;
      }
      if (method === "POST" && pathname === "/api/rotation/recover") {
        await coordinator.recover();
        jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
        return true;
      }
    if (method === "POST" && pathname === "/api/rotation/manual-hold") {
      const body = await readJsonBody(req);
      const message = typeof body.message === "string" && body.message.trim() ? body.message.trim() : "Operator entered Manual Hold";
      await coordinator.enterManualHold(message);
      jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
      return true;
    }
    if (segments[0] === "api" && segments[1] === "rotation" && segments[2] === "pool" && segments[3]) {
      const proxyAccountKey = decodeURIComponent(segments[3]);
      if (method === "PUT") {
        const body = await readJsonBody(req);
        const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
        if (!fileName) throw new Error("fileName is required");
        await coordinator.upsertPoolMember({ proxyAccountKey, fileName, exclusivityAttested: body.exclusivityAttested === true });
        jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
        return true;
      }
      if (method === "DELETE") {
        await coordinator.removePoolMember(proxyAccountKey);
        jsonResponse(res, 200, { ok: true, rotation: coordinator.publicState() });
        return true;
      }
    }
    jsonResponse(res, 404, { error: "rotation endpoint not found" });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    jsonResponse(res, /management key|required|must be/.test(message) ? 409 : 400, { error: message, rotation: coordinator.publicState() });
    return true;
  }
}
