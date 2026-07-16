import type { RotationPriorityWriter } from "./rotation-types.js";

const MAX_MANAGEMENT_PRIORITY = 2_147_483_647;

export const CLI_PROXY_PRIORITY_CONTRACT_VERSION = "7.2.75";
export const CLI_PROXY_PRIORITY_CONTRACT_COMMIT = "75df9810620eae13f04f906c4ec7aad3355a844e";

type ManagementAuthFile = {
  name?: unknown;
  id?: unknown;
  fileName?: unknown;
  priority?: unknown;
  priority_present?: unknown;
  revision?: unknown;
  disabled?: unknown;
  note?: unknown;
};

export type CliProxyManagementWriterOptions = {
  baseUrl: string;
  managementKey: string;
  fetchImpl?: typeof fetch;
  expectedVersion?: string;
  expectedCommit?: string;
    fingerprintResolver: (fileName: string) => Promise<string> | string;
    proxyAccountKeyResolver?: (fileName: string) => Promise<string> | string;
};

function normalizedLoopbackBaseUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname)) {
    throw new Error("CLIProxy management API must use authenticated HTTP loopback");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function recordFromPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function authFilesFromPayload(payload: unknown): ManagementAuthFile[] {
  if (Array.isArray(payload)) return payload as ManagementAuthFile[];
  const record = recordFromPayload(payload);
  if (Array.isArray(record.data)) return record.data as ManagementAuthFile[];
  if (Array.isArray(record.files)) return record.files as ManagementAuthFile[];
  if (Array.isArray(record.authFiles)) return record.authFiles as ManagementAuthFile[];
  return [];
}

function authFileName(entry: ManagementAuthFile): string {
  for (const value of [entry.name, entry.fileName, entry.id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function authFileRevision(entry: ManagementAuthFile, fileName: string): string {
  if (typeof entry.revision !== "string" || !entry.revision.trim()) {
    throw new Error(`CLIProxy auth entry missing revision: ${fileName}`);
  }
  return entry.revision.trim();
}

function authFilePriorityState(entry: ManagementAuthFile, fileName: string): { priority: number; explicitPriority: boolean } {
  if (typeof entry.priority_present !== "boolean") {
    throw new Error(`CLIProxy auth entry missing exact priority presence: ${fileName}`);
  }
  if (!entry.priority_present) return { priority: 0, explicitPriority: false };
  if (typeof entry.priority !== "number" || !Number.isSafeInteger(entry.priority) || entry.priority < 0 || entry.priority > MAX_MANAGEMENT_PRIORITY) {
    throw new Error(`CLIProxy auth entry has unsafe priority: ${fileName}`);
  }
  return { priority: entry.priority, explicitPriority: true };
}

export function createCliProxyManagementWriter(options: CliProxyManagementWriterOptions): RotationPriorityWriter {
  const baseUrl = normalizedLoopbackBaseUrl(options.baseUrl);
  if (!options.managementKey) throw new Error("CLIProxy management key is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const expectedVersion = (options.expectedVersion ?? CLI_PROXY_PRIORITY_CONTRACT_VERSION).trim();
  const expectedCommit = (options.expectedCommit ?? CLI_PROXY_PRIORITY_CONTRACT_COMMIT).trim();
  if (!expectedVersion || !expectedCommit) throw new Error("Accepted CLIProxy runtime version and commit pin are required");
  let lock = Promise.resolve();

  const withLock = async <T>(task: () => Promise<T>): Promise<T> => {
    const previous = lock;
    let release!: () => void;
    lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };

  const request = async (pathname: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.managementKey}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
    const version = response.headers.get("x-cpa-version") ?? "";
    const commit = response.headers.get("x-cpa-commit") ?? "";
    const buildDate = response.headers.get("x-cpa-build-date") ?? "";
    if (version !== expectedVersion || commit !== expectedCommit || !buildDate) {
      throw new Error(`CLIProxy runtime identity mismatch: expected ${expectedVersion}/${expectedCommit}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("CLIProxy management authentication failed");
    }
    if (response.status === 404) {
      throw new Error("CLIProxy management API is disabled or incompatible");
    }

    const text = await response.text();
    let payload: unknown = {};
    if (text) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        throw new Error("CLIProxy management response was not valid JSON");
      }
    }
    if (!response.ok) {
      const code = recordFromPayload(payload).code;
      if (code === "routing_incompatible") {
        throw new Error("CLIProxy routing is incompatible with conditional priority mutation");
      }
      if (code === "revision_conflict") {
        throw new Error("CLIProxy priority revision conflict");
      }
      throw new Error(`CLIProxy management request failed with ${response.status}${typeof code === "string" ? ` (${code})` : ""}`);
    }
    return payload;
  };

  const verifyProxyAccountMapping = async (fileName: string, proxyAccountKey: string): Promise<void> => {
    if (!options.proxyAccountKeyResolver) return;
    const resolvedKey = (await options.proxyAccountKeyResolver(fileName)).trim();
    if (!resolvedKey) throw new Error(`CLIProxy Proxy Account Key unavailable: ${fileName}`);
    if (resolvedKey !== proxyAccountKey) {
      throw new Error(`CLIProxy Proxy Account Key does not match target file name: ${fileName}`);
    }
  };

  const listAccounts = async () => {
    const entries = authFilesFromPayload(await request("/v0/management/auth-files"));
    return await Promise.all(entries.map(async (entry) => {
      const fileName = authFileName(entry);
      if (!fileName) throw new Error("CLIProxy auth entry missing file name");
        const fingerprint = (await options.fingerprintResolver(fileName)).trim();
        if (!fingerprint) throw new Error(`CLIProxy credential fingerprint unavailable: ${fileName}`);
        const proxyAccountKey = (await options.proxyAccountKeyResolver?.(fileName) ?? fileName).trim();
        if (!proxyAccountKey) throw new Error(`CLIProxy Proxy Account Key unavailable: ${fileName}`);
        return {
          proxyAccountKey,
        fileName,
        ...authFilePriorityState(entry, fileName),
        revision: authFileRevision(entry, fileName),
        fingerprint,
        disabled: entry.disabled === true,
        note: typeof entry.note === "string" ? entry.note : "",
      };
    }));
  };

  const patchPriority = async (input: { fileName: string; expectedRevision: string; operation: "set" | "unset"; priority?: number }) => {
    const fileName = input.fileName.trim();
    const expectedRevision = input.expectedRevision.trim();
    if (!fileName) throw new Error("CLIProxy target file name is required");
    if (!expectedRevision) throw new Error("CLIProxy expected revision is required");
    if (input.operation === "set" && (typeof input.priority !== "number" || !Number.isSafeInteger(input.priority) || input.priority < 0 || input.priority > MAX_MANAGEMENT_PRIORITY)) {
      throw new Error("Unsafe CLIProxy priority value");
    }

    const body: Record<string, unknown> = { name: fileName, expected_revision: expectedRevision, operation: input.operation };
    if (input.operation === "set") body.priority = input.priority;
    const payload = recordFromPayload(await request("/v0/management/auth-files/priority", {
      method: "PATCH",
      body: JSON.stringify(body),
    }));
    const responsePriority = recordFromPayload(payload.priority);
    const responseName = typeof payload.name === "string" ? payload.name : "";
    const responseID = typeof payload.id === "string" ? payload.id : "";
    const revision = typeof payload.revision === "string" ? payload.revision.trim() : "";
    const expectedPresent = input.operation === "set";
    if (payload.persisted !== true || (responseName !== fileName && responseID !== fileName) || !revision || revision === expectedRevision) {
      throw new Error("CLIProxy priority mutation response verification failed");
    }
    if (responsePriority.present !== expectedPresent || (expectedPresent && responsePriority.value !== input.priority) || (!expectedPresent && "value" in responsePriority)) {
      throw new Error("CLIProxy priority mutation response verification failed");
    }
    return { revision, priority: expectedPresent ? input.priority ?? 0 : 0, explicitPriority: expectedPresent };
  };

  return {
    readAccounts: async () => await withLock(listAccounts),
    setTargetPriority: async (input) => await withLock(async () => {
      await verifyProxyAccountMapping(input.fileName, input.proxyAccountKey);
      const mutation = await patchPriority({ fileName: input.fileName, expectedRevision: input.expectedRevision, operation: "set", priority: input.priority });
      const account = (await listAccounts()).find((entry) => entry.fileName === input.fileName);
      if (!account || account.priority !== input.priority || !account.explicitPriority || account.revision !== mutation.revision) {
        throw new Error("CLIProxy priority mutation verification failed");
      }
      if (account.fingerprint !== input.expectedFingerprint) {
        throw new Error("CLIProxy target identity verification failed");
      }
      return { priority: account.priority, explicitPriority: true, revision: account.revision, fingerprint: account.fingerprint };
    }),
    restoreBasePriorities: async (entries) => await withLock(async () => {
      for (const entry of Object.values(entries)) {
        await verifyProxyAccountMapping(entry.fileName, entry.proxyAccountKey);
        const mutation = await patchPriority({
          fileName: entry.fileName,
          expectedRevision: entry.expectedRevision,
          operation: entry.present ? "set" : "unset",
          ...(entry.present ? { priority: entry.value } : {}),
        });
        const account = (await listAccounts()).find((candidate) => candidate.fileName === entry.fileName);
        if (!account || account.priority !== (entry.value ?? 0) || account.explicitPriority !== entry.present || account.revision !== mutation.revision || account.fingerprint !== entry.expectedFingerprint) {
          throw new Error("CLIProxy base priority restoration verification failed");
        }
      }
    }),
  };
}
