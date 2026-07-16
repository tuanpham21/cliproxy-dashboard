import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const REQUIRED_SCHEMA_FILES = [
  "ClientRequest.json",
  "v2/GetAccountResponse.json",
  "v2/GetAccountRateLimitsResponse.json",
  "v2/ConsumeAccountRateLimitResetCreditParams.json",
  "v2/ConsumeAccountRateLimitResetCreditResponse.json",
] as const;
const REQUIRED_OUTCOMES = new Set(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]);
const READ_ONLY_NO_FOLLOW = constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);

export type CodexRuntimeIdentity = {
  canonicalPath: string;
  version: string;
  fileIdentity: string;
  schemaHash: string;
};

export type CodexRuntimeQualification =
  | {
      status: "qualified";
      version: string;
      identity: CodexRuntimeIdentity;
    }
  | {
      status: "runtime-unavailable";
      code: "codex_runtime_unavailable";
      message: "Codex runtime unavailable. Check the configured Codex path.";
    }
  | {
      status: "runtime-incompatible";
      code: "codex_runtime_incompatible";
      message: "Installed Codex does not expose the required usage-reset methods.";
    };

export interface CodexRuntimeQualifierLike {
  qualify(codexBin: string): Promise<CodexRuntimeQualification>;
  matchesIdentity(identity: CodexRuntimeIdentity, verifyVersion?: boolean): Promise<boolean>;
  close(): Promise<void>;
}

export type CodexRuntimeQualifierLimits = {
  maxEntries: number;
  maxTotalBytes: number;
  maxInspectedFileBytes: number;
};

export type CodexRuntimeQualifierDependencies = {
  env?: { PATH?: string; PATHEXT?: string };
  platform?: NodeJS.Platform;
  tempParent?: string;
  runCommand?: (binary: string, args: string[], timeoutMs: number) => Promise<{ stdout: string }>;
  removeTree?: (root: string) => Promise<void>;
  limits?: CodexRuntimeQualifierLimits;
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_LIMITS: CodexRuntimeQualifierLimits = {
  maxEntries: 4096,
  maxTotalBytes: 16 * 1024 * 1024,
  maxInspectedFileBytes: 2 * 1024 * 1024,
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultRunCommand(binary: string, args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout) });
      },
    );
  });
}

function hasExactRequired(record: JsonRecord, fields: readonly string[]): boolean {
  const required = record.required;
  return Array.isArray(required) &&
    required.length === fields.length &&
    fields.every((field) => required.includes(field));
}

function hasProperty(record: JsonRecord, field: string): boolean {
  return isRecord(record.properties) && Object.prototype.hasOwnProperty.call(record.properties, field);
}

function hasExactReference(value: unknown, reference: string): boolean {
  return isRecord(value) && value.$ref === reference && Object.keys(value).every((key) => key === "$ref");
}

function hasExactNullableReference(value: unknown, reference: string): boolean {
  if (!isRecord(value) || !Array.isArray(value.anyOf) || value.anyOf.length !== 2) return false;
  if (Object.keys(value).some((key) => key !== "anyOf")) return false;
  return value.anyOf.some((variant) => hasExactReference(variant, reference)) &&
    value.anyOf.some((variant) => isRecord(variant) && variant.type === "null" && Object.keys(variant).length === 1);
}

function hasExactAllOfReference(value: unknown, reference: string): boolean {
  return isRecord(value) &&
    Object.keys(value).every((key) => key === "allOf" || key === "description") &&
    Array.isArray(value.allOf) &&
    value.allOf.length === 1 &&
    hasExactReference(value.allOf[0], reference);
}

function hasExactArrayItemsReference(value: unknown, reference: string): boolean {
  if (!isRecord(value) || !isRecord(value.items) || !hasExactReference(value.items, reference)) return false;
  if (Object.keys(value).some((key) => key !== "type" && key !== "items" && key !== "description")) return false;
  if (!Array.isArray(value.type)) return false;
  return value.type.length === 2 && value.type.includes("array") && value.type.includes("null");
}

function hasMethodVariant(
  clientRequest: JsonRecord,
  method: string,
  params: { required: boolean; reference?: string },
): boolean {
  if (!Array.isArray(clientRequest.oneOf)) return false;
  const matches = clientRequest.oneOf.filter((variant) => {
    if (!isRecord(variant) || variant.type !== "object" || !Array.isArray(variant.required)) return false;
    if (Object.keys(variant).some((key) => key !== "type" && key !== "required" && key !== "properties" && key !== "title")) {
      return false;
    }
    const expectedRequired = params.required ? ["id", "method", "params"] : ["id", "method"];
    if (!hasExactRequired(variant, expectedRequired)) return false;
    const properties = isRecord(variant.properties) ? variant.properties : null;
    const methodProperty = properties && isRecord(properties.method) ? properties.method : null;
    if (!properties || Object.keys(properties).some((key) => key !== "id" && key !== "method" && key !== "params")) return false;
    if (!hasExactReference(properties.id, "#/definitions/RequestId")) return false;
    if (!methodProperty || methodProperty.type !== "string" || !Array.isArray(methodProperty.enum)) return false;
    if (Object.keys(methodProperty).some((key) => key !== "type" && key !== "enum" && key !== "title")) return false;
    if (methodProperty.enum.length !== 1 || methodProperty.enum[0] !== method) return false;
    if (!properties || !Object.hasOwn(properties, "params")) return false;
    const paramsProperty = properties.params;
    return params.reference
      ? hasExactReference(paramsProperty, params.reference)
      : isRecord(paramsProperty) && paramsProperty.type === "null" && Object.keys(paramsProperty).length === 1;
  });
  return matches.length === 1;
}

function schemaContractIsValid(schemas: Map<string, JsonRecord>): boolean {
  const clientRequest = schemas.get("ClientRequest.json");
  const account = schemas.get("v2/GetAccountResponse.json");
  const rateLimits = schemas.get("v2/GetAccountRateLimitsResponse.json");
  const consumeParams = schemas.get("v2/ConsumeAccountRateLimitResetCreditParams.json");
  const consumeResponse = schemas.get("v2/ConsumeAccountRateLimitResetCreditResponse.json");
  if (!clientRequest || !account || !rateLimits || !consumeParams || !consumeResponse) return false;

    if (
      !hasMethodVariant(clientRequest, "account/read", {
        required: true,
        reference: "#/definitions/GetAccountParams",
      }) ||
      !hasMethodVariant(clientRequest, "account/rateLimits/read", { required: false }) ||
      !hasMethodVariant(clientRequest, "account/rateLimitResetCredit/consume", {
        required: true,
        reference: "#/definitions/ConsumeAccountRateLimitResetCreditParams",
      })
    ) {
      return false;
    }

  const accountDefinitions = isRecord(account.definitions) ? account.definitions : null;
    const accountUnion = accountDefinitions && isRecord(accountDefinitions.Account) ? accountDefinitions.Account : null;
    const accountVariants = accountUnion && Array.isArray(accountUnion.oneOf) ? accountUnion.oneOf : [];
    const accountProperties = isRecord(account.properties) ? account.properties : null;
    const chatgptVariant = accountVariants.find(
    (variant) =>
      isRecord(variant) &&
      isRecord(variant.properties) &&
      isRecord(variant.properties.type) &&
      Array.isArray(variant.properties.type.enum) &&
      variant.properties.type.enum.includes("chatgpt"),
  );
  if (
      !hasExactRequired(account, ["requiresOpenaiAuth"]) ||
      !hasExactNullableReference(accountProperties?.account, "#/definitions/Account") ||
    !isRecord(chatgptVariant) ||
      !hasExactRequired(chatgptVariant, ["email", "planType", "type"]) ||
    !hasProperty(chatgptVariant, "email") ||
    !hasProperty(chatgptVariant, "planType")
  ) {
    return false;
  }

  const rateDefinitions = isRecord(rateLimits.definitions) ? rateLimits.definitions : null;
  const window = rateDefinitions && isRecord(rateDefinitions.RateLimitWindow) ? rateDefinitions.RateLimitWindow : null;
  const summary =
    rateDefinitions && isRecord(rateDefinitions.RateLimitResetCreditsSummary)
      ? rateDefinitions.RateLimitResetCreditsSummary
      : null;
    const credit =
      rateDefinitions && isRecord(rateDefinitions.RateLimitResetCredit) ? rateDefinitions.RateLimitResetCredit : null;
    const rateProperties = isRecord(rateLimits.properties) ? rateLimits.properties : null;
    const snapshot = rateDefinitions && isRecord(rateDefinitions.RateLimitSnapshot) ? rateDefinitions.RateLimitSnapshot : null;
    const snapshotProperties = snapshot && isRecord(snapshot.properties) ? snapshot.properties : null;
    const summaryProperties = summary && isRecord(summary.properties) ? summary.properties : null;
    if (
      !hasExactRequired(rateLimits, ["rateLimits"]) ||
      !hasExactAllOfReference(rateProperties?.rateLimits, "#/definitions/RateLimitSnapshot") ||
      !hasExactNullableReference(rateProperties?.rateLimitResetCredits, "#/definitions/RateLimitResetCreditsSummary") ||
      !window ||
      !hasExactRequired(window, ["usedPercent"]) ||
      !hasProperty(window, "windowDurationMins") ||
      !hasProperty(window, "resetsAt") ||
      !snapshotProperties ||
      !hasExactNullableReference(snapshotProperties.primary, "#/definitions/RateLimitWindow") ||
      !hasExactNullableReference(snapshotProperties.secondary, "#/definitions/RateLimitWindow") ||
      !summary ||
      !hasExactRequired(summary, ["availableCount"]) ||
      !hasExactArrayItemsReference(summaryProperties?.credits, "#/definitions/RateLimitResetCredit") ||
      !credit ||
      !hasExactRequired(credit, ["id", "resetType", "status", "grantedAt"]) ||
    !["expiresAt", "title", "description"].every((field) => hasProperty(credit, field))
  ) {
    return false;
  }

  if (
      !hasExactRequired(consumeParams, ["idempotencyKey"]) ||
    !hasProperty(consumeParams, "idempotencyKey") ||
    !hasProperty(consumeParams, "creditId") ||
      !hasExactRequired(consumeResponse, ["outcome"]) ||
    !hasProperty(consumeResponse, "outcome")
  ) {
    return false;
  }
    const outcomeProperty = isRecord(consumeResponse.properties) ? consumeResponse.properties.outcome : null;
    const outcomeDefinitions = isRecord(consumeResponse.definitions)
      ? consumeResponse.definitions.ConsumeAccountRateLimitResetCreditOutcome
      : null;
    if (
      !isRecord(outcomeProperty) ||
      outcomeProperty.$ref !== "#/definitions/ConsumeAccountRateLimitResetCreditOutcome" ||
      Object.keys(outcomeProperty).some((key) => key !== "$ref")
    ) {
      return false;
    }
    if (
      !isRecord(outcomeDefinitions) ||
      !Array.isArray(outcomeDefinitions.oneOf) ||
      outcomeDefinitions.oneOf.length !== REQUIRED_OUTCOMES.size
    ) {
      return false;
    }
    const outcomes = new Set<string>();
    for (const variant of outcomeDefinitions.oneOf) {
      if (!isRecord(variant) || variant.type !== "string" || !Array.isArray(variant.enum) || variant.enum.length !== 1) {
        return false;
      }
      const [outcome] = variant.enum;
      if (typeof outcome !== "string") return false;
      outcomes.add(outcome);
    }
    return outcomes.size === REQUIRED_OUTCOMES.size && [...REQUIRED_OUTCOMES].every((outcome) => outcomes.has(outcome));
  }

function isInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

export class CodexRuntimeQualifier implements CodexRuntimeQualifierLike {
  private readonly env: { PATH?: string; PATHEXT?: string };
  private readonly platform: NodeJS.Platform;
  private readonly tempParent: string;
  private readonly runCommand: CodexRuntimeQualifierDependencies["runCommand"];
  private readonly removeTree: (root: string) => Promise<void>;
  private readonly limits: CodexRuntimeQualifierLimits;
  private readonly cache = new Map<string, Extract<CodexRuntimeQualification, { status: "qualified" }>>();
  private readonly inFlight = new Map<string, Promise<CodexRuntimeQualification>>();
  private readonly pendingCleanup = new Set<string>();

  constructor(dependencies: CodexRuntimeQualifierDependencies = {}) {
    this.env = dependencies.env ?? process.env;
    this.platform = dependencies.platform ?? process.platform;
    this.tempParent = dependencies.tempParent ?? os.tmpdir();
    this.runCommand = dependencies.runCommand ?? defaultRunCommand;
    this.removeTree = dependencies.removeTree ?? (async (root) => await rm(root, { recursive: true, force: true }));
    this.limits = dependencies.limits ?? DEFAULT_LIMITS;
  }

  async qualify(codexBin: string): Promise<CodexRuntimeQualification> {
    if (this.pendingCleanup.size > 0) return this.incompatible();
    let canonicalPath: string;
    let fileIdentity: string;
    try {
      canonicalPath = await this.resolveExecutable(codexBin);
      fileIdentity = await this.readFileIdentity(canonicalPath);
    } catch {
      return this.unavailable();
    }
    const cacheKey = `${this.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath}|${fileIdentity}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      if (await this.matchesIdentity(cached.identity)) return cached;
      this.cache.delete(cacheKey);
    }
    const running = this.inFlight.get(cacheKey);
    if (running) return running;

    const operation = this.qualifyResolved(canonicalPath, fileIdentity, cacheKey);
    this.inFlight.set(cacheKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(cacheKey) === operation) this.inFlight.delete(cacheKey);
    }
  }

  private async qualifyResolved(
    canonicalPath: string,
    fileIdentity: string,
    cacheKey: string,
  ): Promise<CodexRuntimeQualification> {
    let version: string;
    let identityChanged = false;
    try {
      const versionResult = await this.runCommand!(canonicalPath, ["--version"], 15_000);
      version = versionResult.stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (!version || Buffer.byteLength(version, "utf8") > 256) throw new Error("invalid version");
      if (!(await this.matchesIdentity({ canonicalPath, version: "", fileIdentity, schemaHash: "" }, false))) {
        identityChanged = true;
        throw new Error("runtime changed");
      }
    } catch {
      return identityChanged ? this.incompatible() : this.unavailable();
    }

    await mkdir(this.tempParent, { recursive: true });
    let schemaRoot: string | null = null;
    let result: CodexRuntimeQualification;
    try {
      schemaRoot = await mkdtemp(path.join(this.tempParent, "cliproxy-codex-schema-"));
      await this.verifyPrivateDirectory(schemaRoot);
      if (!(await this.matchesIdentity({ canonicalPath, version, fileIdentity, schemaHash: "" }, false))) {
        throw new Error("runtime changed");
      }
      await this.runCommand!(
        canonicalPath,
        ["app-server", "generate-json-schema", "--out", schemaRoot],
        15_000,
      );
      if (!(await this.matchesIdentity({ canonicalPath, version, fileIdentity, schemaHash: "" }, false))) {
        throw new Error("runtime changed");
      }
      const schemaHash = await this.inspectSchemaRoot(schemaRoot);
      result = {
        status: "qualified",
        version,
        identity: { canonicalPath, version, fileIdentity, schemaHash },
      };
    } catch {
      result = this.incompatible();
    } finally {
      if (schemaRoot) {
        try {
          await this.removeTree(schemaRoot);
        } catch {
          this.pendingCleanup.add(schemaRoot);
          result = this.incompatible();
        }
      }
    }
    if (result.status === "qualified") this.cache.set(cacheKey, result);
    return result;
  }

  async matchesIdentity(identity: CodexRuntimeIdentity, verifyVersion = true): Promise<boolean> {
    try {
      const canonical = await realpath(identity.canonicalPath);
      const expected = this.platform === "win32" ? identity.canonicalPath.toLowerCase() : identity.canonicalPath;
      const actual = this.platform === "win32" ? canonical.toLowerCase() : canonical;
      if (actual !== expected || (await this.readFileIdentity(canonical)) !== identity.fileIdentity) return false;
      if (!verifyVersion) return true;
      const result = await this.runCommand!(canonical, ["--version"], 15_000);
      const version = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
      return version === identity.version && (await this.matchesIdentity(identity, false));
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    for (const root of [...this.pendingCleanup]) {
      try {
        await this.removeTree(root);
        this.pendingCleanup.delete(root);
      } catch {
        // Keep failed cleanup registered for a later shutdown attempt.
      }
    }
  }

  private unavailable(): Extract<CodexRuntimeQualification, { status: "runtime-unavailable" }> {
    return {
      status: "runtime-unavailable",
      code: "codex_runtime_unavailable",
      message: "Codex runtime unavailable. Check the configured Codex path.",
    };
  }

  private incompatible(): Extract<CodexRuntimeQualification, { status: "runtime-incompatible" }> {
    return {
      status: "runtime-incompatible",
      code: "codex_runtime_incompatible",
      message: "Installed Codex does not expose the required usage-reset methods.",
    };
  }

  private async resolveExecutable(codexBin: string): Promise<string> {
    const pathApi = this.platform === "win32" ? path.win32 : path;
    const containsSeparator = codexBin.includes("/") || codexBin.includes("\\");
    const candidates: string[] = [];
    if (pathApi.isAbsolute(codexBin) || containsSeparator) {
      candidates.push(pathApi.resolve(codexBin));
    } else {
        const separator = this.platform === "win32" ? ";" : path.delimiter;
        const extensions =
          this.platform === "win32"
            ? [
                "",
                ...(this.env.PATHEXT ?? ".EXE")
                  .split(";")
                  .map((extension) => extension.toLowerCase())
                  .filter((extension) => extension === ".exe" || extension === ".com"),
              ]
            : [""];
        for (const directory of (this.env.PATH ?? "").split(separator).filter(Boolean)) {
          for (const extension of extensions) candidates.push(pathApi.join(directory, `${codexBin}${extension}`));
        }
      }
      for (const candidate of candidates) {
        try {
          if (this.platform === "win32") {
            const extension = path.win32.extname(candidate).toLowerCase();
            if (extension === ".cmd" || extension === ".bat" || extension === ".js") continue;
          }
          const canonical = await realpath(candidate);
        const metadata = await stat(canonical);
        if (metadata.isFile()) return canonical;
      } catch {
        // Try the next exact candidate.
      }
    }
    throw new Error("runtime unavailable");
  }

  private async readFileIdentity(canonicalPath: string): Promise<string> {
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) throw new Error("not a regular executable");
      return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeMs}:${metadata.ctimeMs}`;
  }

  private async verifyPrivateDirectory(root: string): Promise<void> {
    await chmod(root, 0o700);
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("invalid temp root");
    if (this.platform !== "win32" && (metadata.mode & 0o077) !== 0) throw new Error("temp root is not private");
  }

  private async inspectSchemaRoot(root: string): Promise<string> {
    const canonicalRoot = await realpath(root);
    let entries = 0;
    let totalBytes = 0;
    const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          entries += 1;
          if (entries > this.limits.maxEntries) throw new Error("schema entry rejected");
          const entryPath = path.join(directory, entry.name);
          const metadata = await lstat(entryPath);
          if (metadata.isSymbolicLink()) throw new Error("schema entry rejected");
          const entryRealPath = await realpath(entryPath);
          if (!isInsideRoot(canonicalRoot, entryRealPath)) throw new Error("schema path escape");
          if (metadata.isDirectory()) await walk(entryPath);
          else if (metadata.isFile()) {
            if (metadata.nlink !== 1) throw new Error("schema hard link rejected");
            totalBytes += metadata.size;
          if (totalBytes > this.limits.maxTotalBytes) throw new Error("schema bundle too large");
        } else {
          throw new Error("unsupported schema entry");
        }
      }
    };
    await walk(root);

    const schemas = new Map<string, JsonRecord>();
    const hash = createHash("sha256");
    for (const relativePath of REQUIRED_SCHEMA_FILES) {
      const filePath = path.join(root, relativePath);
      const fileRealPath = await realpath(filePath);
      if (!isInsideRoot(canonicalRoot, fileRealPath)) throw new Error("schema file escape");
        const handle = await open(filePath, READ_ONLY_NO_FOLLOW);
        try {
          const before = await handle.stat();
          const pathBefore = await lstat(filePath);
          if (
            !before.isFile() ||
            !pathBefore.isFile() ||
            pathBefore.isSymbolicLink() ||
            before.dev !== pathBefore.dev ||
            before.ino !== pathBefore.ino ||
            before.nlink !== 1 ||
            pathBefore.nlink !== 1 ||
            before.size > this.limits.maxInspectedFileBytes
          ) {
            throw new Error("invalid schema file");
          }
          const contentBuffer = Buffer.allocUnsafe(this.limits.maxInspectedFileBytes + 1);
          let bytesRead = 0;
          while (bytesRead < contentBuffer.length) {
            const chunk = await handle.read(contentBuffer, bytesRead, contentBuffer.length - bytesRead, bytesRead);
            if (chunk.bytesRead === 0) break;
            bytesRead += chunk.bytesRead;
          }
          if (bytesRead > this.limits.maxInspectedFileBytes) throw new Error("schema file grew");
          const content = contentBuffer.subarray(0, bytesRead);
          const after = await handle.stat();
          const pathAfter = await lstat(filePath);
          if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            before.ctimeMs !== after.ctimeMs ||
            before.dev !== pathAfter.dev ||
            before.ino !== pathAfter.ino ||
            before.size !== pathAfter.size ||
            before.mtimeMs !== pathAfter.mtimeMs ||
            before.ctimeMs !== pathAfter.ctimeMs ||
            pathAfter.isSymbolicLink()
          ) {
            throw new Error("schema file changed");
          }
        const parsed = JSON.parse(content.toString("utf8")) as unknown;
        if (!isRecord(parsed)) throw new Error("invalid schema json");
        schemas.set(relativePath, parsed);
        hash.update(relativePath);
        hash.update("\0");
        hash.update(content);
        hash.update("\0");
      } finally {
        await handle.close();
      }
    }
    if (!schemaContractIsValid(schemas)) throw new Error("schema contract mismatch");
    return hash.digest("hex");
  }
}
