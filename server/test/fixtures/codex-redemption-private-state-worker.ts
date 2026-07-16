import { access } from "node:fs/promises";
import process from "node:process";

import { PrivateRedemptionStateStore, type AcquirePreparedRedemptionInput } from "../../codex-redemption-private-state.js";

const [rootPathForTests, rootAnchorForTests, gatePath, releasePath, proposalId] = process.argv.slice(2);
if (!rootPathForTests || !rootAnchorForTests || !gatePath || !releasePath || !proposalId) process.exit(2);

const input: AcquirePreparedRedemptionInput = {
  proposalId,
  idempotencyKey: proposalId.startsWith("a")
    ? "11111111-2222-4333-8444-555555555555"
    : "66666666-7777-4888-8999-000000000000",
  accountCheck: { email: "operator@example.com", plan: "pro" },
  selection: { mode: "generic" },
  runtimeIdentity: {
    canonicalPath: "C:\\Program Files\\Codex\\codex.exe",
    codexStateRoot: "C:\\Users\\Operator Name\\.codex",
    version: "codex-cli 0.144.4",
    fileIdentity: "1:2:3:4:5",
    schemaHash: "a".repeat(64),
  },
  createdAt: "2026-07-16T12:00:00.000Z",
  expiresAt: "2026-07-16T12:02:00.000Z",
};

async function waitFor(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("worker gate timeout");
}

await waitFor(gatePath);
const store = new PrivateRedemptionStateStore({ platform: process.platform, rootPathForTests, rootAnchorForTests });
try {
  const journal = await store.acquirePrepared(input);
  process.stdout.write(`${JSON.stringify({ status: "acquired", proposalId: journal.proposalId })}\n`);
  await waitFor(releasePath);
  await store.releasePrepared(journal.proposalId, journal.ownerNonce);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    status: "rejected",
    code: typeof error === "object" && error !== null && "code" in error ? String(error.code) : "unknown",
  })}\n`);
}
