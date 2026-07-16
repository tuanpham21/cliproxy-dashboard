import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { openRotationController } from "../rotation-controller.js";
import type { RotationPriorityWriter } from "../rotation-types.js";
import { makeTempRoot } from "./helpers.js";

type ManagedProxyAccount = Awaited<ReturnType<RotationPriorityWriter["readAccounts"]>>[number];

class FakePriorityWriter implements RotationPriorityWriter {
  readonly proxyAccounts = new Map<string, ManagedProxyAccount>();
  readonly setCalls: Array<{ key: string; priority: number }> = [];
  restoreCalls = 0;
  beforeSet?: () => Promise<void> | void;
  afterSet?: (proxyAccounts: Map<string, ManagedProxyAccount>) => Promise<void> | void;
  resultOverride?: Partial<Awaited<ReturnType<RotationPriorityWriter["setTargetPriority"]>>>;
  failRestoreAfter?: number;
  #revision = 10;

  constructor(proxyAccounts: ManagedProxyAccount[]) {
    for (const proxyAccount of proxyAccounts) this.proxyAccounts.set(proxyAccount.proxyAccountKey, structuredClone(proxyAccount));
  }

  async readAccounts(): Promise<ManagedProxyAccount[]> {
    return [...this.proxyAccounts.values()].map((proxyAccount) => structuredClone(proxyAccount));
  }

  async setTargetPriority(input: Parameters<RotationPriorityWriter["setTargetPriority"]>[0]) {
    await this.beforeSet?.();
    const proxyAccount = this.proxyAccounts.get(input.proxyAccountKey);
    if (!proxyAccount || proxyAccount.fileName !== input.fileName || proxyAccount.revision !== input.expectedRevision || proxyAccount.fingerprint !== input.expectedFingerprint) {
      throw new Error("synthetic set conflict");
    }
    proxyAccount.priority = input.priority;
    proxyAccount.explicitPriority = true;
    proxyAccount.revision = `revision-${++this.#revision}`;
    this.setCalls.push({ key: input.proxyAccountKey, priority: input.priority });
    await this.afterSet?.(this.proxyAccounts);
    return {
      priority: input.priority,
      explicitPriority: true as const,
      revision: proxyAccount.revision,
      fingerprint: proxyAccount.fingerprint,
      ...this.resultOverride,
    };
  }

  async restoreBasePriorities(entries: Parameters<RotationPriorityWriter["restoreBasePriorities"]>[0]): Promise<void> {
    for (const entry of Object.values(entries)) {
      const proxyAccount = this.proxyAccounts.get(entry.proxyAccountKey);
      if (!proxyAccount || proxyAccount.fileName !== entry.fileName || proxyAccount.revision !== entry.expectedRevision || proxyAccount.fingerprint !== entry.expectedFingerprint) {
        throw new Error("synthetic restore conflict");
      }
      proxyAccount.priority = entry.value ?? 0;
      proxyAccount.explicitPriority = entry.present;
      proxyAccount.revision = `revision-${++this.#revision}`;
      this.restoreCalls += 1;
      if (this.failRestoreAfter !== undefined && this.restoreCalls >= this.failRestoreAfter) {
        this.failRestoreAfter = undefined;
        throw new Error("synthetic restore crash");
      }
    }
  }
}

function proxyAccount(key: string, priority?: number): ManagedProxyAccount {
  return {
    proxyAccountKey: key,
    fileName: `${key}.json`,
    priority: priority ?? 0,
    explicitPriority: priority !== undefined,
    revision: `revision-${key}`,
    fingerprint: `fingerprint-${key}`,
    disabled: false,
    note: `note-${key}`,
  };
}

async function statePath(): Promise<string> {
  const root = await makeTempRoot();
  const stateDir = path.join(root, "state");
  await mkdir(stateDir, { recursive: true });
  return path.join(stateDir, "rotation.json");
}

const request = {
  observationId: "observation-1",
  evidenceWatermark: "2026-07-16T00:00:00.000Z",
  fromProxyAccountKey: "account-b",
  routingTargetKey: "account-a",
  targetFingerprint: "fingerprint-account-a",
};

describe("rotation controller journal and recovery", () => {
  it("defaults off and enforces singleton ownership", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    const first = await openRotationController({ statePath: filePath, writer });
    expect(first.state()).toMatchObject({ mode: "off", lifecycle: "off", journal: { phase: "idle" } });
    await expect(openRotationController({ statePath: filePath, writer })).rejects.toThrow(/ownership/i);
    await first.close();
    const second = await openRotationController({ statePath: filePath, writer });
    await second.close();
    await writeFile(`${filePath}.lock`, `${JSON.stringify({ pid: 999_999, token: "stale-owner", acquiredAt: "2026-07-16T00:00:00.000Z" })}\n`, "utf8");
    await expect(openRotationController({ statePath: filePath, writer })).rejects.toThrow(/stale-lock recovery/i);
    await unlink(`${filePath}.lock`);
    const recovered = await openRotationController({ statePath: filePath, writer });
    await recovered.close();
  });

  it("holds singleton ownership until an in-flight mutation drains", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    let releaseMutation!: () => void;
    let mutationStarted!: () => void;
    const mutationGate = new Promise<void>((resolve) => { releaseMutation = resolve; });
    const started = new Promise<void>((resolve) => { mutationStarted = resolve; });
    writer.beforeSet = async () => {
      mutationStarted();
      await mutationGate;
    };
    const controller = await openRotationController({ statePath: filePath, writer, mode: "active" });
    const pending = controller.beginPendingRotation(request);
    await started;

    const closing = controller.close();
    await expect(openRotationController({ statePath: filePath, writer })).rejects.toThrow(/ownership/i);
    releaseMutation();
    await pending;
    await closing;

    const reopened = await openRotationController({ statePath: filePath, writer });
    await reopened.close();
  });

  it("journals before one monotonic target mutation, verifies, confirms, and restores exact bases", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    writer.beforeSet = async () => {
      const persisted = JSON.parse(await readFile(filePath, "utf8"));
      expect(persisted).toMatchObject({ journal: { phase: "mutating", routingTargetKey: "account-a", intendedPriority: 11 } });
    };
    const controller = await openRotationController({ statePath: filePath, writer, mode: "active", now: () => Date.parse("2026-07-16T00:00:01.000Z") });

    const pending = await controller.beginPendingRotation(request);
    expect(writer.setCalls).toEqual([{ key: "account-a", priority: 11 }]);
    expect(pending).toMatchObject({ lifecycle: "awaiting-confirmation", journal: { phase: "verified", routingTargetKey: "account-a", intendedPriority: 11 } });
    expect(pending.journal.basePriorities).toMatchObject({
      "account-a": { present: false, fingerprint: "fingerprint-account-a" },
      "account-b": { present: true, value: 10, fingerprint: "fingerprint-account-b" },
    });
    writer.proxyAccounts.get("account-a")!.revision = "revision-after-token-refresh";

    const confirmed = await controller.confirmPendingRotation({
      observationId: request.observationId,
      observedRoutedAccountKey: "account-a",
      observedFingerprint: "fingerprint-account-a",
      evidenceWatermark: "2026-07-16T00:00:02.000Z",
    });
    expect(confirmed).toMatchObject({ routingTargetKey: "account-a", observedRoutedAccountKey: "account-a", evidenceWatermark: "2026-07-16T00:00:02.000Z", journal: { phase: "idle" } });

    writer.beforeSet = undefined;
    await controller.beginPendingRotation({ ...request, observationId: "observation-2", evidenceWatermark: "2026-07-16T00:00:03.000Z", fromProxyAccountKey: "account-a", routingTargetKey: "account-b", targetFingerprint: "fingerprint-account-b" });
    await controller.confirmPendingRotation({ observationId: "observation-2", observedRoutedAccountKey: "account-b", observedFingerprint: "fingerprint-account-b", evidenceWatermark: "2026-07-16T00:00:04.000Z" });
    expect(writer.setCalls).toEqual([{ key: "account-a", priority: 11 }, { key: "account-b", priority: 12 }]);

    const disabled = await controller.disable();
    expect(disabled).toMatchObject({ mode: "off", lifecycle: "off", restorationVerified: true, journal: { phase: "idle" } });
    expect(writer.proxyAccounts.get("account-a")).toMatchObject({ priority: 0, explicitPriority: false, disabled: false, note: "note-account-a" });
    expect(writer.proxyAccounts.get("account-b")).toMatchObject({ priority: 10, explicitPriority: true, disabled: false, note: "note-account-b" });
    await controller.close();
  });

  it("recovers deterministically after journal, mutation, verification, commit, and restoration crashes", async () => {
    for (const crashPhase of ["journaled", "mutating", "mutated", "verified", "committed"] as const) {
      const filePath = await statePath();
      const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
      const crashing = await openRotationController({
        statePath: filePath,
        writer,
        mode: "active",
        crashInjector: (phase) => { if (phase === crashPhase) throw new Error(`crash:${phase}`); },
      });
      if (crashPhase === "committed") {
        await crashing.beginPendingRotation(request);
        await expect(crashing.confirmPendingRotation({ observationId: request.observationId, observedRoutedAccountKey: "account-a", observedFingerprint: "fingerprint-account-a", evidenceWatermark: "2026-07-16T00:00:02.000Z" })).rejects.toThrow(`crash:${crashPhase}`);
      } else {
        await expect(crashing.beginPendingRotation(request)).rejects.toThrow(`crash:${crashPhase}`);
      }
      await crashing.close();

      const recovered = await openRotationController({ statePath: filePath, writer, mode: "active" });
      const state = await recovered.recover();
      expect(state.journal.phase).toBe("idle");
      if (crashPhase === "committed") {
        expect(state.routingTargetKey).toBe("account-a");
        expect(writer.proxyAccounts.get("account-a")?.priority).toBe(11);
      } else {
        expect(writer.proxyAccounts.get("account-a")).toMatchObject({ priority: 0, explicitPriority: false });
      }
      await recovered.close();
    }

    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    const controller = await openRotationController({ statePath: filePath, writer, mode: "active" });
    await controller.beginPendingRotation(request);
    await controller.confirmPendingRotation({ observationId: request.observationId, observedRoutedAccountKey: "account-a", observedFingerprint: "fingerprint-account-a", evidenceWatermark: "2026-07-16T00:00:02.000Z" });
    writer.failRestoreAfter = 1;
    await expect(controller.disable()).rejects.toThrow(/restore crash/);
    await controller.close();
    const recovered = await openRotationController({ statePath: filePath, writer });
    expect((await recovered.recover())).toMatchObject({ mode: "off", lifecycle: "off", restorationVerified: true, journal: { phase: "idle" } });
    await recovered.close();
  });

  it("hard-pauses on identity mismatch, deletion, external priority edits, corrupt state, and headroom exhaustion", async () => {
    const cases: Array<{ name: string; writer: FakePriorityWriter; prepare?: (writer: FakePriorityWriter) => void; pauseReason: string }> = [
      { name: "identity", writer: new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]), prepare: (writer) => { writer.proxyAccounts.get("account-a")!.fingerprint = "replacement"; }, pauseReason: "identity-mismatch" },
      { name: "headroom", writer: new FakePriorityWriter([proxyAccount("account-a", 2_147_483_647), proxyAccount("account-b", 10)]), pauseReason: "insufficient-priority-headroom" },
    ];
    for (const testCase of cases) {
      const filePath = await statePath();
      testCase.prepare?.(testCase.writer);
      const controller = await openRotationController({ statePath: filePath, writer: testCase.writer, mode: "active" });
      expect(await controller.beginPendingRotation(request)).toMatchObject({ lifecycle: "paused", pauseReason: testCase.pauseReason });
      await controller.close();
    }

    for (const mutation of ["delete", "edit"] as const) {
      const filePath = await statePath();
      const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
      writer.afterSet = (proxyAccounts) => {
        if (mutation === "delete") proxyAccounts.delete("account-b");
        else proxyAccounts.get("account-b")!.priority = 99;
      };
      const controller = await openRotationController({ statePath: filePath, writer, mode: "active" });
      expect(await controller.beginPendingRotation(request)).toMatchObject({ lifecycle: "paused" });
      await controller.close();
    }

    const filePath = await statePath();
      await writeFile(filePath, "{not-json", "utf8");
      const corrupt = await openRotationController({ statePath: filePath, writer: new FakePriorityWriter([proxyAccount("account-a")]) });
      expect(corrupt.state()).toMatchObject({ lifecycle: "paused", pauseReason: "corrupt-state" });
      expect(await corrupt.disable()).toMatchObject({ lifecycle: "paused", pauseReason: "corrupt-state", restorationVerified: false });
      await corrupt.close();
  });

  it("hard-pauses when the writer result disagrees with the intended mutation", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    writer.resultOverride = { fingerprint: "unexpected-fingerprint" };
    const controller = await openRotationController({ statePath: filePath, writer, mode: "active" });

    expect(await controller.beginPendingRotation(request)).toMatchObject({
      lifecycle: "paused",
      pauseReason: "mutation-verification-failed",
      journal: { phase: "mutating" },
    });
    await controller.close();
  });

  it("does not commit a verified Pending Rotation after a hard pause", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    const controller = await openRotationController({ statePath: filePath, writer, mode: "active" });
    await controller.beginPendingRotation(request);
    expect(await controller.confirmPendingRotation({
      observationId: request.observationId,
      observedRoutedAccountKey: "account-b",
      observedFingerprint: "fingerprint-account-b",
      evidenceWatermark: "2026-07-16T00:00:02.000Z",
    })).toMatchObject({ lifecycle: "paused", pauseReason: "selection-mismatch", journal: { phase: "verified" } });

    expect(await controller.confirmPendingRotation({
      observationId: request.observationId,
      observedRoutedAccountKey: "account-a",
      observedFingerprint: "fingerprint-account-a",
      evidenceWatermark: "2026-07-16T00:00:03.000Z",
    })).toMatchObject({ lifecycle: "paused", pauseReason: "selection-mismatch", journal: { phase: "verified" } });
    await controller.close();
  });

  it("keeps an external-edit hard pause sticky after the conflicting value is repaired", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    const controller = await openRotationController({ statePath: filePath, writer, mode: "active" });
    await controller.beginPendingRotation(request);
    await controller.confirmPendingRotation({
      observationId: request.observationId,
      observedRoutedAccountKey: "account-a",
      observedFingerprint: "fingerprint-account-a",
      evidenceWatermark: "2026-07-16T00:00:02.000Z",
    });

    writer.proxyAccounts.get("account-a")!.priority = 99;
    expect(await controller.disable()).toMatchObject({ lifecycle: "paused", pauseReason: "external-priority-edit" });
    writer.proxyAccounts.get("account-a")!.priority = 11;

    expect(await controller.beginPendingRotation({
      ...request,
      observationId: "observation-2",
      evidenceWatermark: "2026-07-16T00:00:03.000Z",
    })).toMatchObject({ lifecycle: "paused", pauseReason: "external-priority-edit" });
    await controller.close();
  });

  it("does not clear a hard pause when disable cannot safely roll back a pending mutation", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    writer.afterSet = (proxyAccounts) => { proxyAccounts.get("account-a")!.priority = 99; };
    const controller = await openRotationController({ statePath: filePath, writer, mode: "active" });
    expect(await controller.beginPendingRotation(request)).toMatchObject({
      lifecycle: "paused",
      pauseReason: "mutation-verification-failed",
      journal: { phase: "mutated" },
    });

    expect(await controller.disable()).toMatchObject({
      lifecycle: "paused",
      pauseReason: "external-priority-edit",
      journal: { phase: "mutated" },
      restorationVerified: false,
    });
    await controller.close();
  });

  it("rejects malformed nested persisted state", async () => {
    for (const mutate of [
      (state: Record<string, unknown>) => { state.switchTimestamps = ["not-a-timestamp"]; },
      (state: Record<string, unknown>) => { state.lifecycle = "teleporting"; },
      (state: Record<string, unknown>) => { state.journal = { phase: "committed" }; },
      (state: Record<string, unknown>) => {
        state.overlay = {
          basePriorities: { "account-a": { fileName: "account-a.json", present: false } },
          appliedPriorities: { "account-a": 11 },
        };
      },
    ]) {
      const filePath = await statePath();
      const initial = await openRotationController({ statePath: filePath, mode: "active" });
      await initial.close();
      const persisted = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
      mutate(persisted);
      await writeFile(filePath, `${JSON.stringify(persisted)}\n`, "utf8");

      const corrupt = await openRotationController({ statePath: filePath });
      expect(corrupt.state()).toMatchObject({ lifecycle: "paused", pauseReason: "corrupt-state" });
      await corrupt.close();
    }
  });

  it("rejects committed and disable-restoring state without its matching overlay", async () => {
    const committedPath = await statePath();
    const committedWriter = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    const committing = await openRotationController({
      statePath: committedPath,
      writer: committedWriter,
      mode: "active",
      crashInjector: (phase) => { if (phase === "committed") throw new Error("crash:committed"); },
    });
    await committing.beginPendingRotation(request);
    await expect(committing.confirmPendingRotation({
      observationId: request.observationId,
      observedRoutedAccountKey: "account-a",
      observedFingerprint: "fingerprint-account-a",
      evidenceWatermark: "2026-07-16T00:00:02.000Z",
    })).rejects.toThrow("crash:committed");
    await committing.close();
    const committed = JSON.parse(await readFile(committedPath, "utf8")) as Record<string, unknown>;
    delete committed.overlay;
    await writeFile(committedPath, `${JSON.stringify(committed)}\n`, "utf8");
    const corruptCommitted = await openRotationController({ statePath: committedPath });
    expect(corruptCommitted.state()).toMatchObject({ lifecycle: "paused", pauseReason: "corrupt-state" });
    await corruptCommitted.close();

    const restoringPath = await statePath();
    const restoringWriter = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    const restoring = await openRotationController({
      statePath: restoringPath,
      writer: restoringWriter,
      mode: "active",
      crashInjector: (phase) => { if (phase === "restoring") throw new Error("crash:restoring"); },
    });
    await restoring.beginPendingRotation(request);
    await restoring.confirmPendingRotation({
      observationId: request.observationId,
      observedRoutedAccountKey: "account-a",
      observedFingerprint: "fingerprint-account-a",
      evidenceWatermark: "2026-07-16T00:00:02.000Z",
    });
    await expect(restoring.disable()).rejects.toThrow("crash:restoring");
    await restoring.close();
    const disabling = JSON.parse(await readFile(restoringPath, "utf8")) as Record<string, unknown>;
    delete disabling.overlay;
    await writeFile(restoringPath, `${JSON.stringify(disabling)}\n`, "utf8");
    const corruptRestoring = await openRotationController({ statePath: restoringPath });
    expect(corruptRestoring.state()).toMatchObject({ lifecycle: "paused", pauseReason: "corrupt-state" });
    await corruptRestoring.close();
  });

  it("rejects pending journals whose ledgers do not cover the Routing Target", async () => {
    const filePath = await statePath();
    const writer = new FakePriorityWriter([proxyAccount("account-a"), proxyAccount("account-b", 10)]);
    const crashing = await openRotationController({
      statePath: filePath,
      writer,
      mode: "active",
      crashInjector: (phase) => { if (phase === "journaled") throw new Error("crash:journaled"); },
    });
    await expect(crashing.beginPendingRotation(request)).rejects.toThrow("crash:journaled");
    await crashing.close();
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { journal: Record<string, unknown> };
    persisted.journal.basePriorities = {};
    persisted.journal.previousPriorities = {};
    await writeFile(filePath, `${JSON.stringify(persisted)}\n`, "utf8");

    const corrupt = await openRotationController({ statePath: filePath });
    expect(corrupt.state()).toMatchObject({ lifecycle: "paused", pauseReason: "corrupt-state", restorationVerified: false });
    await corrupt.close();
  });
});
