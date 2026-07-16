import { randomBytes } from "node:crypto";
import process from "node:process";

export type CodexRedemptionAuditEvent = {
  eventId: string;
  event: "codex_redemption_terminal";
  timestamp: string;
  outcome: string;
  codexVersion: string;
  selectionMode: "specific" | "generic";
  reconciliation: string;
};

export type CodexRedemptionAuditSink = (event: CodexRedemptionAuditEvent) => Promise<void> | void;

export const defaultCodexRedemptionAuditSink: CodexRedemptionAuditSink = async (event) => {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
};

export function newRedemptionAuditEventId(): string {
  return randomBytes(32).toString("base64url");
}
