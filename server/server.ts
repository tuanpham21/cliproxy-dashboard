import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import process from "node:process";

import { handleApi, isSameOriginRequest, jsonResponse } from "./api.js";
import { openExternalUrl, resolveCliProxyBin } from "./commands.js";
import { DEFAULT_AUTH_DIR, DEFAULT_CONFIG_PATH } from "./constants.js";
import { defaultQuotaSnapshotStatePath } from "./paths.js";
import { createRotationCoordinator } from "./rotation-coordinator.js";
import { createRotationLogObserver, type RotationObservationBatch } from "./rotation-log-observer.js";
import { serveFrontend } from "./static.js";
import type { DashboardOptions } from "./types.js";

export async function startServer(
  options: DashboardOptions & {
    host: string;
    port: number;
    open?: boolean;
    onRotationObservation?: (batch: RotationObservationBatch) => Promise<void> | void;
  },
): Promise<void> {
  const serverOptions = {
    ...options,
    operatorToken: options.operatorToken ?? randomBytes(32).toString("base64url"),
  };
  const server = createServer(async (req, res) => {
    try {
      if ((req.method ?? "GET").toUpperCase() === "OPTIONS") {
        if (!isSameOriginRequest(req, serverOptions)) {
          jsonResponse(res, 403, { error: "same-origin dashboard request required" });
          return;
        }
        res.writeHead(204, {
          "Access-Control-Allow-Headers": "Content-Type, x-cliproxy-dashboard-token",
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end();
        return;
      }

      if (await handleApi(req, res, serverOptions)) {
        return;
      }

      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname.startsWith("/api/")) {
        jsonResponse(res, 404, { error: "not found" });
        return;
      }

      if (await serveFrontend(req, res, serverOptions)) {
        return;
      }

      jsonResponse(res, 404, { error: "not found" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jsonResponse(res, 500, { error: message });
    }
  });

  const listen = async (port: number): Promise<number> =>
    await new Promise<number>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (typeof address === "object" && address && "port" in address) {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not determine dashboard port"));
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, options.host);
    });

  let actualPort: number;
  try {
    actualPort = await listen(options.port);
    } catch (error) {
      if (options.port !== 0 && options.allowPortFallback !== false) {
        actualPort = await listen(0);
      } else {
        throw error;
      }
    }

    const rotationCoordinator = await createRotationCoordinator(serverOptions);
    const rotationObserver = await createRotationLogObserver(serverOptions, {
      onObservation: async (batch) => {
        await rotationCoordinator.handleObservation(batch);
        await options.onRotationObservation?.(batch);
      },
    });
    try {
      await rotationObserver.start();
    } catch (error) {
      await rotationCoordinator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }

    const url = "http://" + options.host + ":" + actualPort;
  process.stdout.write("Cliproxy dashboard: " + url + "\n");
  process.stdout.write("Config: " + (options.configPath ?? DEFAULT_CONFIG_PATH) + "\n");
  process.stdout.write("Auth dir: " + (options.authDir ?? DEFAULT_AUTH_DIR) + "\n");
  process.stdout.write("Quota snapshot state: " + (options.quotaSnapshotStatePath ?? defaultQuotaSnapshotStatePath(options.authDir ?? DEFAULT_AUTH_DIR)) + "\n");
  process.stdout.write("CLI proxy bin: " + resolveCliProxyBin(options) + "\n");

  if (options.open) {
    openExternalUrl(url);
  }

    const shutdown = async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      await rotationObserver.close();
      await rotationCoordinator.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };
  const onSignal = () => {
    void shutdown();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await new Promise(() => undefined);
}
