import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_FRONTEND_DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../frontend");

const contentTypes = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
]);

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function staticHeaders(contentType: string, cacheControl: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
  };
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, staticHeaders("text/plain; charset=utf-8", "no-store"));
  res.end("not found\n");
}

function serviceUnavailable(res: ServerResponse, message: string): void {
  res.writeHead(503, staticHeaders("text/plain; charset=utf-8", "no-store"));
  res.end(message.endsWith("\n") ? message : message + "\n");
}

function resolveAssetPath(frontendDistDir: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/assets/") || decoded.includes("\0")) {
    return null;
  }
  const relativePath = decoded.slice("/assets/".length);
  if (!relativePath) {
    return null;
  }
  const assetRoot = path.resolve(frontendDistDir, "assets");
  const resolved = path.resolve(assetRoot, relativePath);
  const relative = path.relative(assetRoot, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

export async function serveFrontend(
  req: IncomingMessage,
  res: ServerResponse,
  options: { operatorToken: string; frontendDistDir?: string },
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return false;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const frontendDistDir = options.frontendDistDir ?? DEFAULT_FRONTEND_DIST_DIR;

  if (url.pathname === "/") {
    try {
      const indexPath = path.join(frontendDistDir, "index.html");
      const html = await readFile(indexPath, "utf8");
      res.writeHead(200, staticHeaders("text/html; charset=utf-8", "no-store"));
      res.end(method === "HEAD" ? undefined : html);
    } catch {
      serviceUnavailable(res, "Frontend build is missing. Run pnpm run build:frontend.");
    }
    return true;
  }

  if (!url.pathname.startsWith("/assets/")) {
    return false;
  }

  const assetPath = resolveAssetPath(frontendDistDir, url.pathname);
  if (!assetPath) {
    notFound(res);
    return true;
  }

  try {
    const assetStat = await stat(assetPath);
    if (!assetStat.isFile()) {
      notFound(res);
      return true;
    }
    const contentType = contentTypes.get(path.extname(assetPath).toLowerCase()) ?? "application/octet-stream";
    const body = await readFile(assetPath);
    res.writeHead(200, staticHeaders(contentType, "public, max-age=31536000, immutable"));
    res.end(method === "HEAD" ? undefined : body);
  } catch {
    notFound(res);
  }
  return true;
}
