import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { vi } from "vitest";

export type FakeCodexWriteHandler = (
  message: Record<string, unknown>,
  acknowledge: (error?: Error | null) => void,
  child: FakeCodexProcess,
) => void;

export class FakeCodexProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly writes: Array<Record<string, unknown>> = [];
  killed = false;
  closeOnKill = true;
  readonly killSignals: Array<NodeJS.Signals | number | undefined> = [];
  writeHandler: FakeCodexWriteHandler | null = null;
  throwOnWrite: Error | null = null;

  readonly stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: (data: string, callback?: (error?: Error | null) => void): boolean => {
      if (this.throwOnWrite) {
        const error = this.throwOnWrite;
        this.throwOnWrite = null;
        throw error;
      }
      const message = JSON.parse(data.trim()) as Record<string, unknown>;
      this.writes.push(message);
      const acknowledge = (error?: Error | null) => queueMicrotask(() => callback?.(error));
      this.writeHandler?.(message, acknowledge, this);
      if (!this.writeHandler) acknowledge();
      return true;
    },
    end: vi.fn(() => {
      this.stdin.destroyed = true;
    }),
  });

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    if (this.closeOnKill) {
      queueMicrotask(() => {
        this.emit("exit", 0, null);
        this.emit("close", 0, null);
      });
    }
    return true;
  }

  sendJson(value: unknown, suffix = "\n"): void {
    this.stdout.write(`${JSON.stringify(value)}${suffix}`);
  }

  closeWith(code = 1): void {
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

export function createFakeCodexSpawn(child: FakeCodexProcess) {
  return vi.fn(() => {
    queueMicrotask(() => child.emit("spawn"));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

export function initializeFakeCodexProcess(
  child: FakeCodexProcess,
  handleRequest: FakeCodexWriteHandler,
): void {
  child.writeHandler = (message, acknowledge, process) => {
    if (message.method === "initialize") {
      acknowledge();
      queueMicrotask(() => {
        process.sendJson({
          jsonrpc: "2.0",
          id: message.id,
          result: { serverInfo: { name: "codex-test", version: "0.144.4" } },
        });
      });
      return;
    }
    if (message.method === "initialized") {
      acknowledge();
      return;
    }
    queueMicrotask(() => handleRequest(message, acknowledge, process));
  };
}
