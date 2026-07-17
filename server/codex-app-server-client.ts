import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";

export type CodexAppServerWriteDisposition = "not-written" | "possibly-written";

export type CodexAppServerTransportErrorCode =
  | "spawn-failed"
  | "before-write-failed"
  | "write-failed"
  | "process-exited"
  | "protocol-error"
  | "stdout-overflow"
  | "timeout"
  | "process-close-timeout"
  | "session-closed";

export class CodexAppServerTransportError extends Error {
  readonly code: CodexAppServerTransportErrorCode;
  readonly writeDisposition: CodexAppServerWriteDisposition;
  readonly hookErrorCode?: string;

  constructor(code: CodexAppServerTransportErrorCode, writeDisposition: CodexAppServerWriteDisposition, hookCause?: unknown) {
    super("Codex app-server transport failed.");
    this.name = "CodexAppServerTransportError";
    this.code = code;
    this.writeDisposition = writeDisposition;
    this.hookErrorCode = typeof hookCause === "object" && hookCause !== null && "code" in hookCause
      ? String((hookCause as { code?: unknown }).code)
      : undefined;
  }
}

export class CodexAppServerRpcError extends Error {
  readonly rpcCode: number | string;
  readonly category: "authentication-required" | "other";

  constructor(rpcCode: number | string) {
    super("Codex app-server request failed.");
    this.name = "CodexAppServerRpcError";
    this.rpcCode = rpcCode;
    this.category = rpcCode === -32001 ? "authentication-required" : "other";
  }
}

export type CodexAppServerSpawn = (
  command: string,
  args: string[],
  options: { shell: false; windowsHide: boolean; stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams;

export type CodexAppServerSessionOptions = {
  codexBin: string;
  codexHome?: string;
  spawnProcess?: CodexAppServerSpawn;
  platform?: NodeJS.Platform;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxStdoutLineBytes?: number;
  maxStderrBytes?: number;
  onNotification?: (notification: CodexAppServerNotification) => Promise<void> | void;
  onUnexpectedProcessClose?: () => Promise<void> | void;
};

export type CodexAppServerNotification = { method: string; params?: unknown };

export type CodexAppServerRequestOptions = {
  timeoutMs?: number;
  beforeWrite?: () => Promise<void> | void;
  afterWrite?: () => Promise<void> | void;
};

type PendingRequest = {
  id: number;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  writeDisposition: CodexAppServerWriteDisposition;
  writeAcknowledged: boolean;
  afterWriteCompleted: boolean;
  response?: { result: unknown } | { error: CodexAppServerRpcError };
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 16 * 1024;
const CODEX_APP_ACCOUNT_PROVIDER_OVERRIDE = 'model_provider="openai"';

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSpawnProcess(command: string, args: string[], options: Parameters<CodexAppServerSpawn>[2]) {
  return spawn(command, args, options);
}

export class CodexAppServerSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new StringDecoder("utf8");
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completedResponseIds = new Set<number>();
  private readonly completedResponseOrder: number[] = [];
  private readonly requestTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly maxStdoutLineBytes: number;
  private readonly maxStderrBytes: number;
  private readonly onNotification?: CodexAppServerSessionOptions["onNotification"];
  private readonly onUnexpectedProcessClose?: CodexAppServerSessionOptions["onUnexpectedProcessClose"];
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrBytes = 0;
  private state: "starting" | "ready" | "failed" | "closed" = "starting";
  private spawnState: "pending" | "spawned" | "failed" = "pending";
  private readonly spawnWaiters: Array<{
    resolve: () => void;
    reject: (error: CodexAppServerTransportError) => void;
  }> = [];
  private processClosed = false;
  private readyOnce = false;
  private requestTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private readonly processClosePromise: Promise<void>;
  private resolveProcessClose!: () => void;

  private readonly onStdout = (chunk: Buffer | string) => this.handleStdout(chunk);
  private readonly onStderr = (chunk: Buffer | string) => this.handleStderr(chunk);
  private readonly onProcessSpawn = () => this.handleProcessSpawn();
  private readonly onProcessError = () => {
    if (this.spawnState === "pending") this.failSpawn();
    else this.failTransport("process-exited");
  };
  private readonly onProcessExit = () => this.handleProcessClose();
  private readonly onProcessClose = () => this.handleProcessClose();
  private readonly onStdinError = () => this.failTransport("write-failed");

  private constructor(options: CodexAppServerSessionOptions) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.maxStdoutLineBytes = options.maxStdoutLineBytes ?? DEFAULT_MAX_STDOUT_LINE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    this.onNotification = options.onNotification;
    this.onUnexpectedProcessClose = options.onUnexpectedProcessClose;
    this.processClosePromise = new Promise((resolve) => {
      this.resolveProcessClose = resolve;
    });
    const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    try {
      this.child = spawnProcess(
        options.codexBin,
        ["app-server", "-c", CODEX_APP_ACCOUNT_PROVIDER_OVERRIDE, "--stdio"],
        {
          shell: false,
          windowsHide: (options.platform ?? process.platform) === "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: options.codexHome ? { ...process.env, CODEX_HOME: options.codexHome } : process.env,
        },
      );
    } catch {
      this.state = "failed";
      throw new CodexAppServerTransportError("spawn-failed", "not-written");
    }
    this.child.stdout.on("data", this.onStdout);
    this.child.stderr.on("data", this.onStderr);
    this.child.stdin.on("error", this.onStdinError);
    this.child.on("spawn", this.onProcessSpawn);
    this.child.on("error", this.onProcessError);
    this.child.on("exit", this.onProcessExit);
    this.child.on("close", this.onProcessClose);
  }

  static async start(options: CodexAppServerSessionOptions): Promise<CodexAppServerSession> {
    const session = new CodexAppServerSession(options);
    try {
      await session.waitForSpawn();
      await session.sendRequestNow(
        "initialize",
        {
          clientInfo: { name: "cliproxy-dashboard", title: "Cliproxy Dashboard", version: "1.0.0" },
          capabilities: { requestAttestation: false },
        },
        { timeoutMs: options.requestTimeoutMs },
        true,
      );
      await session.sendNotification("initialized");
      session.state = "ready";
      session.readyOnce = true;
      return session;
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  request<T>(method: string, params: unknown, options: CodexAppServerRequestOptions = {}): Promise<T> {
    const run = this.requestTail.then(() => this.sendRequestNow<T>(method, params, options, false));
    this.requestTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async sendRequestNow<T>(
    method: string,
    params: unknown,
    options: CodexAppServerRequestOptions,
    allowStarting: boolean,
  ): Promise<T> {
    if (!this.canSend(allowStarting)) {
      throw new CodexAppServerTransportError("session-closed", "not-written");
    }
    try {
      await options.beforeWrite?.();
    } catch (error) {
      throw new CodexAppServerTransportError("before-write-failed", "not-written", error);
    }
    if (!this.canSend(allowStarting)) {
      throw new CodexAppServerTransportError("session-closed", "not-written");
    }

    const id = this.nextRequestId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.failTransport("timeout"), options.timeoutMs ?? this.requestTimeoutMs);
      const pending: PendingRequest = {
        id,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        writeDisposition: "not-written",
        writeAcknowledged: false,
        afterWriteCompleted: false,
      };
      this.pending.set(id, pending);
      try {
        pending.writeDisposition = "possibly-written";
        this.child.stdin.write(payload, (error?: Error | null) => {
          if (!this.pending.has(id)) return;
          if (error) {
            this.failTransport("write-failed");
            return;
          }
          pending.writeAcknowledged = true;
          Promise.resolve(options.afterWrite?.()).then(
            () => {
              pending.afterWriteCompleted = true;
              this.finishPendingIfReady(pending);
            },
            () => this.failTransport("write-failed"),
          );
        });
      } catch {
        this.failTransport("write-failed");
      }
    });
  }

  private async sendNotification(method: string): Promise<void> {
    if (this.state === "failed" || this.state === "closed") {
      throw new CodexAppServerTransportError("session-closed", "not-written");
    }
    const payload = `${JSON.stringify({ jsonrpc: "2.0", method })}\n`;
    await new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(payload, (error?: Error | null) => {
          if (error) reject(new CodexAppServerTransportError("write-failed", "possibly-written"));
          else resolve();
        });
      } catch {
        reject(new CodexAppServerTransportError("write-failed", "not-written"));
      }
    });
  }

  private canSend(allowStarting: boolean): boolean {
    return this.state === "ready" || (allowStarting && this.state === "starting");
  }

  private handleStdout(chunk: Buffer | string): void {
    if (this.state === "closed") return;
    this.stdoutBuffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      let line = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (Buffer.byteLength(line, "utf8") > this.maxStdoutLineBytes) {
        this.failTransport("stdout-overflow");
        return;
      }
      if (line.trim()) this.handleLine(line);
      if (this.state === "failed") return;
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxStdoutLineBytes) {
      this.failTransport("stdout-overflow");
    }
  }

  private handleStderr(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    this.stderrBytes = Math.min(this.maxStderrBytes, this.stderrBytes + bytes);
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.failTransport("protocol-error");
      return;
    }
    if (!isRecord(parsed)) {
      this.failTransport("protocol-error");
      return;
    }
    if (parsed.jsonrpc !== undefined && parsed.jsonrpc !== "2.0") {
      this.failTransport("protocol-error");
      return;
    }
    if (typeof parsed.method === "string" && parsed.id === undefined) {
      const notification = Object.hasOwn(parsed, "params")
        ? { method: parsed.method, params: parsed.params }
        : { method: parsed.method };
      try {
        void Promise.resolve(this.onNotification?.(notification)).catch(() => {});
      } catch {
        // Observation cannot poison transport.
      }
      return;
    }
    if (!Number.isInteger(parsed.id)) {
      this.failTransport("protocol-error");
      return;
    }
    const responseId = parsed.id as number;
    if (this.completedResponseIds.has(responseId)) {
      this.failTransport("protocol-error");
      return;
    }
    const pending = this.pending.get(responseId);
    if (!pending) {
      this.failTransport("protocol-error");
      return;
    }
    if (pending.response) {
      this.failTransport("protocol-error");
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(parsed, "result");
    const hasError = Object.prototype.hasOwnProperty.call(parsed, "error");
    if (hasResult === hasError) {
      this.failTransport("protocol-error");
      return;
    }
    if (hasError) {
      if (!isRecord(parsed.error) || (typeof parsed.error.code !== "number" && typeof parsed.error.code !== "string")) {
        this.failTransport("protocol-error");
        return;
      }
      pending.response = { error: new CodexAppServerRpcError(parsed.error.code) };
    } else {
      pending.response = { result: parsed.result };
    }
    this.finishPendingIfReady(pending);
  }

  private finishPendingIfReady(pending: PendingRequest): void {
    if (!pending.response || !pending.writeAcknowledged || !pending.afterWriteCompleted) return;
    this.pending.delete(pending.id);
    this.completedResponseIds.add(pending.id);
    this.completedResponseOrder.push(pending.id);
    if (this.completedResponseOrder.length > 64) {
      const oldest = this.completedResponseOrder.shift();
      if (oldest !== undefined) this.completedResponseIds.delete(oldest);
    }
    clearTimeout(pending.timer);
    if ("error" in pending.response) pending.reject(pending.response.error);
    else pending.resolve(pending.response.result);
  }

  private failTransport(code: CodexAppServerTransportErrorCode): void {
    if (this.state === "closed") return;
    this.state = "failed";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerTransportError(code, pending.writeDisposition));
    }
    this.pending.clear();
    if (!this.processClosed && !this.child.killed) this.child.kill("SIGTERM");
  }

  private handleProcessClose(): void {
    if (this.processClosed) return;
    const unexpected = this.readyOnce && this.state !== "closed";
    this.processClosed = true;
    if (this.spawnState === "pending") this.failSpawn();
    if (this.state !== "closed") this.failTransport("process-exited");
    this.resolveProcessClose();
    if (unexpected) {
      try {
        void Promise.resolve(this.onUnexpectedProcessClose?.()).catch(() => {});
      } catch {
        // Observation cannot poison transport.
      }
    }
  }

  private handleProcessSpawn(): void {
    if (this.spawnState !== "pending") return;
    this.spawnState = "spawned";
    for (const waiter of this.spawnWaiters.splice(0)) waiter.resolve();
  }

  private failSpawn(): void {
    if (this.spawnState !== "pending") return;
    this.spawnState = "failed";
    this.state = "failed";
    const error = new CodexAppServerTransportError("spawn-failed", "not-written");
    for (const waiter of this.spawnWaiters.splice(0)) waiter.reject(error);
    if (!this.processClosed && !this.child.killed) this.child.kill("SIGTERM");
  }

  private waitForSpawn(): Promise<void> {
    if (this.spawnState === "spawned") return Promise.resolve();
    if (this.spawnState === "failed") {
      return Promise.reject(new CodexAppServerTransportError("spawn-failed", "not-written"));
    }
    return new Promise((resolve, reject) => this.spawnWaiters.push({ resolve, reject }));
  }

  private async closeInternal(): Promise<void> {
    this.state = "closed";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CodexAppServerTransportError("session-closed", pending.writeDisposition));
    }
    this.pending.clear();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (!this.processClosed && !this.child.killed) this.child.kill("SIGTERM");
    if (!this.processClosed && !(await this.waitForProcessClose(this.closeTimeoutMs))) {
      this.child.kill("SIGKILL");
      if (!(await this.waitForProcessClose(this.closeTimeoutMs))) {
        throw new CodexAppServerTransportError("process-close-timeout", "not-written");
      }
    }
    this.child.stdout.off("data", this.onStdout);
    this.child.stderr.off("data", this.onStderr);
    this.child.stdin.off("error", this.onStdinError);
    this.child.off("spawn", this.onProcessSpawn);
    this.child.off("error", this.onProcessError);
    this.child.off("exit", this.onProcessExit);
    this.child.off("close", this.onProcessClose);
  }

  private waitForProcessClose(timeoutMs: number): Promise<boolean> {
    if (this.processClosed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.processClosePromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

export function startCodexAppServerSession(options: CodexAppServerSessionOptions): Promise<CodexAppServerSession> {
  return CodexAppServerSession.start(options);
}
