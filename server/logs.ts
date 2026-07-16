import { createReadStream } from "node:fs";
import { access, open, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { DEFAULT_LOG_BYTES } from "./constants.js";
import type { CodexSelectionLogLine, LogSummary, RequestLogLine, SelectorLogLine } from "./types.js";

export async function readTailText(filePath: string, limitBytes = DEFAULT_LOG_BYTES): Promise<string> {
  try {
    const fileHandle = await open(filePath, "r");
    try {
      const fileStat = await fileHandle.stat();
      const size = Math.min(fileStat.size, limitBytes);
      const buffer = Buffer.alloc(size);
      if (size === 0) {
        return "";
      }
      await fileHandle.read(buffer, 0, size, fileStat.size - size);
      return buffer.toString("utf8");
    } finally {
      await fileHandle.close();
    }
  } catch {
    return "";
  }
}

export const selectorLinePattern =
  /^\[(?<timestamp>[^\]]+)\] \[(?<traceId>[^\]]+)\] \[(?<level>[^\]]+)\] \[(?<source>[^\]]+)\] (?<message>.*)$/;
export const selectorDetailsPattern =
  /session=(?<session>\S+)\s+auth=(?<auth>\S+)\s+provider=(?<provider>\S+)\s+model=(?<model>\S+)/;
export const requestLinePattern =
  /^\[(?<timestamp>[^\]]+)\] \[(?<traceId>[^\]]+)\] \[(?<level>[^\]]+)\] \[(?<source>[^\]]+)\] (?<status>\d{3}) \|\s*(?<duration>[^|]+?)\s*\|\s*(?<client>[^|]+?)\s*\|\s*(?<method>[A-Z]+)\s+"(?<path>[^"]+)"/;

export function parseSelectorLine(line: string): SelectorLogLine | null {
  const outer = selectorLinePattern.exec(line);
  if (!outer?.groups) {
    return null;
  }
  const detail = selectorDetailsPattern.exec(outer.groups.message);
  if (!detail?.groups) {
    return null;
  }
  return {
    timestamp: outer.groups.timestamp,
    traceId: outer.groups.traceId,
    level: outer.groups.level.trim(),
    source: outer.groups.source,
    session: detail.groups.session,
    auth: detail.groups.auth,
    provider: detail.groups.provider,
    model: detail.groups.model,
    raw: line,
  };
}

export function parseRequestLine(line: string): RequestLogLine | null {
  const match = requestLinePattern.exec(line);
  if (!match?.groups) {
    return null;
  }
  return {
    timestamp: match.groups.timestamp,
    traceId: match.groups.traceId,
    level: match.groups.level.trim(),
    source: match.groups.source,
    status: Number(match.groups.status),
    duration: match.groups.duration.trim(),
    client: match.groups.client.trim(),
    method: match.groups.method,
    path: match.groups.path,
    raw: line,
  };
}

export const responseLogFilePattern = /^v1-responses-.*\.log$/;
export const responseAuthPattern =
  /^Auth:\s+provider=(?<provider>[^,]+),\s+auth_id=(?<auth>[^,]+),\s+label=(?<label>[^,]+),\s+type=(?<type>\S+)\s*$/;
export const responseTimestampPattern = /^Timestamp:\s*(?<timestamp>.+)$/;

export function parseCodexSelectionFromResponseLog(
  text: string,
  fileName: string,
): CodexSelectionLogLine | null {
  const lines = text.split(/\r?\n/);
  const authLine = lines.find((line) => line.trimStart().startsWith("Auth: provider=codex,"));
  if (!authLine) {
    return null;
  }
  const match = responseAuthPattern.exec(authLine.trim());
  if (!match?.groups) {
    return null;
  }
  const timestampLine = lines.find((line) => responseTimestampPattern.test(line.trim()));
  const timestamp = timestampLine?.trim().match(responseTimestampPattern)?.groups?.timestamp ?? "";
  return {
    timestamp,
    auth: match.groups.auth,
    provider: match.groups.provider,
    raw: authLine.trim(),
    fileName,
    label: match.groups.label,
    type: match.groups.type,
  };
}

export async function readLatestCodexSelection(logsDir: string): Promise<CodexSelectionLogLine | null> {
  try {
    await access(logsDir);
  } catch {
    return null;
  }

  const entries = await readdir(logsDir, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && responseLogFilePattern.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(logsDir, entry.name);
        try {
          const stats = await stat(filePath);
          return { fileName: entry.name, filePath, mtimeMs: stats.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  const recentFiles = files
    .filter(
      (entry): entry is { fileName: string; filePath: string; mtimeMs: number } => entry !== null,
    )
    .sort(
      (left, right) => right.mtimeMs - left.mtimeMs || right.fileName.localeCompare(left.fileName),
    )
    .slice(0, 10);

  for (const entry of recentFiles) {
    try {
      const text = await readFile(entry.filePath, "utf8");
      const parsed = parseCodexSelectionFromResponseLog(text, entry.fileName);
      if (parsed) {
        return parsed;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function collectLogMatches<T>(
  text: string,
  parser: (line: string) => T | null,
  limit: number,
): T[] {
  if (!text) {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const matches: T[] = [];
  for (let index = lines.length - 1; index >= 0 && matches.length < limit; index -= 1) {
    const parsed = parser(lines[index].trimEnd());
    if (parsed) {
      matches.push(parsed);
    }
  }
  return matches;
}

export async function readLogSummary(logPath: string): Promise<LogSummary> {
  const tailText = await readTailText(logPath);
  const recentSelections = collectLogMatches(tailText, parseSelectorLine, 25);
  const recentRequests = collectLogMatches(tailText, parseRequestLine, 25);
  const latestSelection = recentSelections[0] ?? null;
  return {
    latestSelection,
    latestCodexSelection: null,
    recentSelections,
    latestRequest: recentRequests[0] ?? null,
    recentRequests,
  };
}

type CompletedRoute = { auth: string; traceId: string; observedAt: string };

function collectCompletedCodexRoute(
  line: string,
  selections: Map<string, SelectorLogLine>,
  requests: Map<string, RequestLogLine>,
  completed: Map<string, CompletedRoute>,
): void {
  const selection = parseSelectorLine(line);
  if (selection?.auth.startsWith("codex-")) {
    selections.set(selection.traceId, selection);
    const request = requests.get(selection.traceId);
    if (request) completed.set(selection.traceId, { auth: selection.auth, traceId: selection.traceId, observedAt: request.timestamp });
  }
  const request = parseRequestLine(line);
  if (request) {
    requests.set(request.traceId, request);
    const selectionForRequest = selections.get(request.traceId);
    if (selectionForRequest) completed.set(request.traceId, { auth: selectionForRequest.auth, traceId: request.traceId, observedAt: request.timestamp });
  }
}

export function parseCompletedCodexRoutes(lines: Iterable<string>): CompletedRoute[] {
  const selections = new Map<string, SelectorLogLine>();
  const requests = new Map<string, RequestLogLine>();
  const completed = new Map<string, CompletedRoute>();
  for (const line of lines) collectCompletedCodexRoute(line, selections, requests, completed);
  return [...completed.values()];
}

export async function readCompletedCodexRoutes(
  logPath: string,
): Promise<CompletedRoute[]> {
  const selections = new Map<string, SelectorLogLine>();
  const requests = new Map<string, RequestLogLine>();
  const completed = new Map<string, CompletedRoute>();
  try {
    const lines = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) collectCompletedCodexRoute(line, selections, requests, completed);
  } catch {
    return [];
  }
  return [...completed.values()];
}
