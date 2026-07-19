import type { IncomingMessage, ServerResponse } from "node:http";

import type { ConfirmCodexProfileInput } from "../shared/codex-profile-onboarding-types.js";
import {
  CodexProfileOnboardingError,
  type CodexProfileOnboardingService,
} from "./codex-profile-onboarding-service.js";
import type { DashboardOptions } from "./types.js";

export type CodexProfileOnboardingController = Pick<
  CodexProfileOnboardingService,
  "create" | "observe" | "retry" | "confirm" | "cancel" | "startReLogin"
>;

type JsonResponse = (res: ServerResponse, status: number, payload: unknown) => void;
type ReadJsonBody = (req: IncomingMessage) => Promise<Record<string, unknown>>;

const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{24,80}$/;

export async function handleCodexProfileApi(
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  pathname: string,
  segments: string[],
  options: Pick<DashboardOptions, "host">,
  service: CodexProfileOnboardingController | undefined,
  jsonResponse: JsonResponse,
  readJsonBody: ReadJsonBody,
): Promise<boolean> {
  if (segments[0] !== "api" || segments[1] !== "codex" || segments[2] !== "login-profiles") return false;
  if (!isLoopbackHost(options.host) || !isLoopbackAddress(req.socket.remoteAddress)) {
    jsonResponse(res, 403, {
      code: "codex_profile_onboarding_unavailable",
      error: "Codex Login Profile onboarding is available only from a loopback-local dashboard.",
    });
    return true;
  }
  if (!service) {
    jsonResponse(res, 503, {
      code: "codex_profile_onboarding_unavailable",
      error: "Codex Login Profile onboarding is unavailable.",
    });
    return true;
  }

  try {
    if (method === "POST" && pathname === "/api/codex/login-profiles") {
      assertEmptyProfileRequest(await safeBody(req, readJsonBody, "profile"));
      jsonResponse(res, 201, await service.create());
      return true;
    }
    const profileId = segments[3];
    if (!profileId || !PROFILE_ID_PATTERN.test(profileId)) {
      jsonResponse(res, 404, { code: "profile-not-pending", error: "Codex Login Profile not found." });
      return true;
    }
    if (method === "GET" && segments.length === 5 && segments[4] === "onboarding") {
      jsonResponse(res, 200, await service.observe(profileId));
      return true;
    }
      if (method === "POST" && segments.length === 5 && segments[4] === "retry") {
      assertEmptyProfileRequest(await safeBody(req, readJsonBody, "profile"));
      jsonResponse(res, 200, await service.retry(profileId));
        return true;
      }
      if (method === "POST" && segments.length === 5 && segments[4] === "login-again") {
        assertEmptyProfileRequest(await safeBody(req, readJsonBody, "profile"));
        jsonResponse(res, 200, await service.startReLogin(profileId));
        return true;
      }
    if (method === "POST" && segments.length === 5 && segments[4] === "confirm") {
      jsonResponse(res, 200, await service.confirm(profileId, confirmationInput(await safeBody(req, readJsonBody, "confirmation"))));
      return true;
    }
    if (method === "DELETE" && segments.length === 4) {
      jsonResponse(res, 200, await service.cancel(profileId));
      return true;
    }
  } catch (error) {
    respondOnboardingError(res, error, jsonResponse);
    return true;
  }
  return false;
}

function confirmationInput(body: Record<string, unknown>): ConfirmCodexProfileInput {
  const keys = Object.keys(body).sort();
  if (
    keys.join(",") !== "confirmed,email,plan" ||
    body.confirmed !== true ||
    typeof body.email !== "string" ||
    !body.email.trim() ||
    Buffer.byteLength(body.email, "utf8") > 320 ||
    typeof body.plan !== "string" ||
    !body.plan ||
    Buffer.byteLength(body.plan, "utf8") > 80
  ) {
    throw new CodexProfileRequestError("confirmation");
  }
  return { confirmed: true, email: body.email.trim(), plan: body.plan };
}

function assertEmptyProfileRequest(body: Record<string, unknown>): void {
  if (Object.keys(body).length !== 0) throw new CodexProfileRequestError("profile");
}

async function safeBody(
  req: IncomingMessage,
  readJsonBody: ReadJsonBody,
  kind: "profile" | "confirmation",
): Promise<Record<string, unknown>> {
  try {
    return await readJsonBody(req);
  } catch {
    throw new CodexProfileRequestError(kind);
  }
}

class CodexProfileRequestError extends Error {
  constructor(readonly kind: "profile" | "confirmation") {
    super();
  }
}

function respondOnboardingError(res: ServerResponse, error: unknown, jsonResponse: JsonResponse): void {
  if (error instanceof CodexProfileRequestError) {
    jsonResponse(res, 400, error.kind === "profile"
      ? { code: "invalid-profile-request", error: "Codex Login Profile roots are managed by the dashboard." }
      : { code: "invalid-confirmation", error: "Valid account confirmation is required." });
    return;
  }
  if (error instanceof CodexProfileOnboardingError) {
      const status = error.code === "profile-not-pending" ? 404
        : error.code === "confirmation-mismatch" || error.code === "retained-redemption-mismatch" || error.code === "profile-busy" ? 409
        : 503;
    const message = error.code === "confirmation-mismatch"
      ? "The observed Codex account changed. Retry login or check the account again."
      : error.code === "cleanup-failed"
        ? "Couldn’t safely clean up this Codex Login Profile."
          : error.code === "login-failed"
            ? "Codex browser login did not complete."
            : error.code === "retained-redemption-mismatch"
              ? "This fresh account does not match retained reset-redemption recovery. Retry with the original account."
              : error.code === "recovery-unavailable"
                ? "Reset-redemption recovery cannot be safely checked on this host."
                : error.code === "profile-busy"
                  ? "This Codex Login Profile is busy. Try again after its current action finishes."
            : "Couldn’t check this Codex Login Profile.";
    jsonResponse(res, status, { code: error.code, error: message });
    return;
  }
  jsonResponse(res, 503, { code: "read-failed", error: "Couldn’t check this Codex Login Profile." });
}

export function isLoopbackHost(host: string | undefined): boolean {
  const normalized = (host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}
