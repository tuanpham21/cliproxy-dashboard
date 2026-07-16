import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type CodexExecutableEnvironment = { PATH?: string; PATHEXT?: string };

export async function resolveCodexExecutable(
  codexBin: string,
  platform: NodeJS.Platform,
  env: CodexExecutableEnvironment,
): Promise<string> {
  const pathApi = platform === "win32" ? path.win32 : path;
  const containsSeparator = codexBin.includes("/") || codexBin.includes("\\");
  const candidates: string[] = [];
  if (pathApi.isAbsolute(codexBin) || containsSeparator) {
    candidates.push(pathApi.resolve(codexBin));
  } else {
    const separator = platform === "win32" ? ";" : path.delimiter;
    const extensions = platform === "win32"
      ? [
          "",
          ...(env.PATHEXT ?? ".EXE")
            .split(";")
            .map((extension) => extension.toLowerCase())
            .filter((extension) => extension === ".exe" || extension === ".com"),
        ]
      : [""];
    for (const directory of (env.PATH ?? "").split(separator).filter(Boolean)) {
      for (const extension of extensions) candidates.push(pathApi.join(directory, `${codexBin}${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      if (platform === "win32") {
        const extension = path.win32.extname(candidate).toLowerCase();
        if (extension === ".cmd" || extension === ".bat" || extension === ".js") continue;
      }
      const canonical = await realpath(candidate);
      if ((await stat(canonical)).isFile()) return canonical;
    } catch {
      // Try next exact candidate.
    }
  }
  throw new Error("runtime unavailable");
}

export async function readCodexFileIdentity(canonicalPath: string): Promise<string> {
  const metadata = await stat(canonicalPath);
  if (!metadata.isFile()) throw new Error("not a regular executable");
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
}
