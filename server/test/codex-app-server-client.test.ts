import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CodexAppServerTransportError,
  startCodexAppServerSession as startRawCodexAppServerSession,
  type CodexAppServerSessionOptions,
} from "../codex-app-server-client.js";
import {
  FakeCodexProcess,
  createFakeCodexSpawn,
  initializeFakeCodexProcess,
} from "./fake-codex-process.js";

const TEST_RUNTIME_CONTEXT = {
  codexStateRoot: "/private/test-codex-state",
  codexSqliteRoot: "/private/test-codex-sqlite",
};

function startCodexAppServerSession(
  options: Omit<CodexAppServerSessionOptions, "runtimeContext"> & {
    runtimeContext?: CodexAppServerSessionOptions["runtimeContext"];
  },
) {
  return startRawCodexAppServerSession({
    ...options,
    runtimeContext: options.runtimeContext ?? TEST_RUNTIME_CONTEXT,
  });
}

describe("Codex app-server session", () => {
  it("pins both Codex runtime roots and the built-in OpenAI provider for app-server", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, () => {});
    const spawnProcess = createFakeCodexSpawn(child);
    const runtimeContext = {
      codexStateRoot: "/private/profiles/profile-a/codex",
      codexSqliteRoot: "/private/profiles/profile-a/sqlite",
    };

    const session = await startCodexAppServerSession({
      codexBin: "/opt/codex/bin/codex",
      runtimeContext,
      env: {
        PATH: "/usr/bin",
        CODEX_HOME: "/untrusted/inherited-codex",
        CODEX_SQLITE_HOME: "/untrusted/inherited-sqlite",
      },
      spawnProcess,
    });
    await session.close();

    expect(spawnProcess).toHaveBeenCalledWith(
      "/opt/codex/bin/codex",
      [
        "app-server",
        "-c",
        'model_provider="openai"',
        "-c",
        `sqlite_home=${JSON.stringify(runtimeContext.codexSqliteRoot)}`,
        "--stdio",
      ],
      expect.objectContaining({
        env: {
          PATH: "/usr/bin",
          CODEX_HOME: runtimeContext.codexStateRoot,
          CODEX_SQLITE_HOME: runtimeContext.codexSqliteRoot,
        },
      }),
    );
  });

  it("accepts Codex JSONL envelopes that omit the optional jsonrpc marker", async () => {
    const child = new FakeCodexProcess();
    const onNotification = vi.fn();
    child.writeHandler = (message, acknowledge, process) => {
      acknowledge();
      if (message.method === "initialize") {
        process.sendJson({ id: message.id, result: { userAgent: "codex-test" } });
        return;
      }
      if (message.method === "initialized") return;
      process.sendJson({ method: "remoteControl/status/changed", params: {} });
      process.sendJson({ id: message.id, result: { account: null, requiresOpenaiAuth: true } });
    };
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
      onNotification,
    });

    await expect(session.request("account/read", { refreshToken: false })).resolves.toEqual({
      account: null,
      requiresOpenaiAuth: true,
    });
    expect(onNotification).toHaveBeenCalledWith({ method: "remoteControl/status/changed", params: {} });
    await session.close();
  });

  it("reuses one process for sequential JSONL requests and ignores interleaved notifications", async () => {
    const child = new FakeCodexProcess();
    const onNotification = vi.fn();
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      if (message.method === "account/read") {
        const response = `${JSON.stringify({ jsonrpc: "2.0", method: "account/updated", params: {} })}\n${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { account: null, requiresOpenaiAuth: true },
        })}\n`;
        process.stdout.write(response.slice(0, 17));
        process.stdout.write(response.slice(17));
        return;
      }
      process.sendJson({
        jsonrpc: "2.0",
        id: message.id,
        result: { rateLimits: {}, rateLimitResetCredits: { availableCount: 2, credits: null } },
      });
    });
    const spawnProcess = createFakeCodexSpawn(child);

      const session = await startCodexAppServerSession({
        codexBin: "C:\\Program Files\\Codex\\codex.exe",
        runtimeContext: {
          codexStateRoot: "C:\\Users\\Operator Name\\Codex State",
          codexSqliteRoot: "C:\\Users\\Operator Name\\Codex SQLite",
        },
      spawnProcess,
      platform: "win32",
      onNotification,
    });
    const account = await session.request("account/read", { refreshToken: false });
    const usage = await session.request("account/rateLimits/read", {});
    await session.close();

    expect(account).toEqual({ account: null, requiresOpenaiAuth: true });
    expect(usage).toEqual({ rateLimits: {}, rateLimitResetCredits: { availableCount: 2, credits: null } });
    expect(onNotification).toHaveBeenCalledWith({ method: "account/updated", params: {} });
    expect(child.writes.map((message) => message.id).filter(Boolean)).toEqual([1, 2, 3]);
    expect(child.writes[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { requestAttestation: false } },
    });
    expect(JSON.stringify(child.writes[0])).not.toContain("experimentalApi");
    expect(spawnProcess).toHaveBeenCalledWith(
      "C:\\Program Files\\Codex\\codex.exe",
        [
          "app-server",
          "-c",
          'model_provider="openai"',
          "-c",
          'sqlite_home="C:\\\\Users\\\\Operator Name\\\\Codex SQLite"',
          "--stdio",
        ],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
          env: expect.objectContaining({
            CODEX_HOME: "C:\\Users\\Operator Name\\Codex State",
            CODEX_SQLITE_HOME: "C:\\Users\\Operator Name\\Codex SQLite",
          }),
      }),
    );
    expect(child.killed).toBe(true);
  });

  it("runs durable write hooks in order and classifies accepted-request failures as possibly written", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      queueMicrotask(() => {
        process.stderr.write("provider-secret-body");
        process.closeWith(1);
      });
    });
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
    });
    const events: string[] = [];

    const request = session.request("account/rateLimits/read", {}, {
      beforeWrite: async () => events.push("dispatch-intent"),
      afterWrite: async () => events.push("dispatched"),
    });

    await expect(request).rejects.toMatchObject({
      name: "CodexAppServerTransportError",
      code: "process-exited",
      writeDisposition: "possibly-written",
      message: "Codex app-server transport failed.",
    });
    await expect(request).rejects.not.toHaveProperty("message", expect.stringContaining("provider-secret-body"));
    expect(events).toEqual(["dispatch-intent", "dispatched"]);
    await session.close();
  });

  it("fails cleanup when the direct app-server child survives TERM and KILL deadlines", async () => {
    const child = new FakeCodexProcess();
    child.closeOnKill = false;
    initializeFakeCodexProcess(child, () => {});
    const session = await startCodexAppServerSession({
      codexBin: "C:\\Program Files\\Codex\\codex.exe",
      spawnProcess: createFakeCodexSpawn(child),
      platform: "win32",
      closeTimeoutMs: 1,
    });

    await expect(session.close()).rejects.toMatchObject({
      name: "CodexAppServerTransportError",
      code: "process-close-timeout",
      writeDisposition: "not-written",
    });
    expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("classifies pre-write barriers as not written and write-call failures as possibly written", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, () => {});
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
    });

    await expect(
      session.request("account/read", {}, { beforeWrite: async () => Promise.reject(new Error("journal failed")) }),
    ).rejects.toMatchObject({ writeDisposition: "not-written", code: "before-write-failed" });

    child.throwOnWrite = new Error("closed stdin");
    await expect(session.request("account/read", {})).rejects.toMatchObject({
      writeDisposition: "possibly-written",
      code: "write-failed",
    });
    await session.close();
  });

  it("fails closed on malformed or oversized stdout without leaking diagnostics", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (_message, acknowledge, process) => {
      acknowledge();
      process.stdout.write("not-json\n");
    });
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
      maxStdoutLineBytes: 128,
      maxStderrBytes: 8,
    });

    await expect(session.request("account/read", {})).rejects.toMatchObject({
      code: "protocol-error",
      writeDisposition: "possibly-written",
    });
    await session.close();

    const overflowChild = new FakeCodexProcess();
    initializeFakeCodexProcess(overflowChild, (_message, acknowledge, process) => {
      acknowledge();
      process.stdout.write("x".repeat(129));
    });
    const overflowSession = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(overflowChild),
      maxStdoutLineBytes: 128,
    });
    const overflow = overflowSession.request("account/read", {});
    await expect(overflow).rejects.toBeInstanceOf(CodexAppServerTransportError);
    await expect(overflow).rejects.toMatchObject({ code: "stdout-overflow", writeDisposition: "possibly-written" });
    await overflowSession.close();
  });

  it("times out after accepted write and closes idempotently", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (_message, acknowledge) => acknowledge());
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
      requestTimeoutMs: 15,
      closeTimeoutMs: 30,
    });

    await expect(session.request("account/read", {})).rejects.toMatchObject({
      code: "timeout",
      writeDisposition: "possibly-written",
    });
    await Promise.all([session.close(), session.close()]);
    expect(child.killed).toBe(true);
  });

  it("preserves split UTF-8 code points across stdout chunks", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      const payload = Buffer.from(
        `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { title: "café" } })}\n`,
        "utf8",
      );
      const splitAt = payload.indexOf(Buffer.from("é", "utf8")) + 1;
      process.stdout.write(payload.subarray(0, splitAt));
      process.stdout.write(payload.subarray(splitAt));
    });
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
    });

    await expect(session.request("account/read", {})).resolves.toEqual({ title: "café" });
    await session.close();
  });

  it("poisons the session after early exit or duplicate responses", async () => {
    const exitedChild = new FakeCodexProcess();
    initializeFakeCodexProcess(exitedChild, () => {});
    const exitedSession = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(exitedChild),
    });
    exitedChild.closeWith(1);
    await expect(exitedSession.request("account/read", {})).rejects.toMatchObject({
      code: "session-closed",
      writeDisposition: "not-written",
    });
    await exitedSession.close();

    const duplicateChild = new FakeCodexProcess();
    let responseId = 0;
    initializeFakeCodexProcess(duplicateChild, (message, acknowledge, process) => {
      acknowledge();
      responseId = message.id as number;
      process.sendJson({ jsonrpc: "2.0", id: responseId, result: { ok: true } });
    });
    const duplicateSession = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(duplicateChild),
    });
    await duplicateSession.request("account/read", {});
    duplicateChild.sendJson({ jsonrpc: "2.0", id: responseId, result: { ok: true } });
    await expect(duplicateSession.request("account/rateLimits/read", {})).rejects.toMatchObject({
      code: "session-closed",
      writeDisposition: "not-written",
    });
    await duplicateSession.close();
  });

  it("observes unexpected ready-session process closure but not deliberate close", async () => {
    const exitedChild = new FakeCodexProcess();
    initializeFakeCodexProcess(exitedChild, () => {});
    const onUnexpectedProcessClose = vi.fn();
    const exitedSession = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(exitedChild),
      onUnexpectedProcessClose,
    });

    exitedChild.closeWith(1);
    expect(onUnexpectedProcessClose).toHaveBeenCalledTimes(1);
    await exitedSession.close();
    expect(onUnexpectedProcessClose).toHaveBeenCalledTimes(1);

    const closedChild = new FakeCodexProcess();
    initializeFakeCodexProcess(closedChild, () => {});
    const onDeliberateClose = vi.fn();
    const closedSession = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(closedChild),
      onUnexpectedProcessClose: onDeliberateClose,
    });
    await closedSession.close();
    expect(onDeliberateClose).not.toHaveBeenCalled();
  });

  it("classifies an asynchronous spawn error before initialization write", async () => {
    const child = new FakeCodexProcess();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("ENOENT /private/codex")));
      return child as never;
    });

    await expect(
      startCodexAppServerSession({ codexBin: "missing-codex", spawnProcess }),
    ).rejects.toMatchObject({ code: "spawn-failed", writeDisposition: "not-written" });
  });

  it("classifies a real missing executable as not written", async () => {
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const missingBinary = path.join(process.cwd(), ".missing-codex-binary", "codex");

    await expect(
      startCodexAppServerSession({
        codexBin: missingBinary,
        spawnProcess: (command, args, options) => actual.spawn(command, args, options),
        closeTimeoutMs: 50,
      }),
    ).rejects.toMatchObject({ code: "spawn-failed", writeDisposition: "not-written" });
  });

  it("fails closed on duplicate responses before write acknowledgement completes", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      process.sendJson({ jsonrpc: "2.0", id: message.id, result: { first: true } });
      process.sendJson({ jsonrpc: "2.0", id: message.id, result: { second: true } });
    });
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
    });
    const afterWrite = new Promise<void>(() => {});

    await expect(session.request("account/read", {}, { afterWrite: () => afterWrite })).rejects.toMatchObject({
      code: "protocol-error",
      writeDisposition: "possibly-written",
    });
    await session.close();
  });

  it("fails closed on an unknown response id", async () => {
    const child = new FakeCodexProcess();
    initializeFakeCodexProcess(child, (_message, acknowledge, process) => {
      acknowledge();
      process.sendJson({ jsonrpc: "2.0", id: 999, result: { wrong: true } });
    });
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
    });

    await expect(session.request("account/read", {})).rejects.toMatchObject({
      code: "protocol-error",
      writeDisposition: "possibly-written",
    });
    await session.close();
  });

  it("serializes concurrent requests and rejects queued work as not written after transport failure", async () => {
    const child = new FakeCodexProcess();
    let firstRequestId = 0;
    initializeFakeCodexProcess(child, (message, acknowledge, process) => {
      acknowledge();
      if (message.method === "account/read") {
        firstRequestId = message.id as number;
        return;
      }
      process.sendJson({ jsonrpc: "2.0", id: message.id, result: { second: true } });
    });
    const session = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(child),
    });
    const first = session.request("account/read", {});
    const second = session.request("account/rateLimits/read", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(child.writes.map((message) => message.method)).toEqual(["initialize", "initialized", "account/read"]);
    child.sendJson({ jsonrpc: "2.0", id: firstRequestId, result: { first: true } });
    await expect(first).resolves.toEqual({ first: true });
    await expect(second).resolves.toEqual({ second: true });
    await session.close();

    const failedChild = new FakeCodexProcess();
    initializeFakeCodexProcess(failedChild, (_message, acknowledge, process) => {
      acknowledge();
      process.closeWith(1);
    });
    const failedSession = await startCodexAppServerSession({
      codexBin: "codex",
      spawnProcess: createFakeCodexSpawn(failedChild),
    });
    const failedFirst = failedSession.request("account/read", {});
    const failedSecond = failedSession.request("account/rateLimits/read", {});
    await expect(failedFirst).rejects.toMatchObject({
      code: "process-exited",
      writeDisposition: "possibly-written",
    });
    await expect(failedSecond).rejects.toMatchObject({
      code: "session-closed",
      writeDisposition: "not-written",
    });
    await failedSession.close();
  });
});
