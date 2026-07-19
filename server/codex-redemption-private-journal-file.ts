import {
  parseRedemptionJournal,
  type RedemptionJournal,
} from "./codex-redemption-journal.js";
import { redemptionStateTargetsProfileId } from "./codex-redemption-profile-binding.js";

export const PRIVATE_REDEMPTION_JOURNAL_MAX_BYTES = 16 * 1024;
export const ACTIVE_REDEMPTION_JOURNAL_CANDIDATE = /^\.active-redemption\.[A-Za-z0-9-]+\.candidate$/;

type ReadOptionalPrivateRedemptionJournalInput = {
  activePath: string;
  canonicalRoot: string;
  profileId?: string;
  readPrivateFile(
    filePath: string,
    canonicalRoot: string,
    minimumBytes: number,
    maximumBytes: number,
    publicationCandidatePattern?: RegExp,
  ): Promise<Buffer>;
};

export type OptionalPrivateRedemptionJournal =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "journal"; journal: RedemptionJournal };

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function readOptionalPrivateRedemptionJournal(
  input: ReadOptionalPrivateRedemptionJournalInput,
): Promise<OptionalPrivateRedemptionJournal> {
  let content: Buffer;
  try {
    content = await input.readPrivateFile(
      input.activePath,
      input.canonicalRoot,
      2,
      PRIVATE_REDEMPTION_JOURNAL_MAX_BYTES,
      ACTIVE_REDEMPTION_JOURNAL_CANDIDATE,
    );
  } catch (error) {
    return isEnoent(error) ? { kind: "missing" } : { kind: "invalid" };
  }
  try {
    const parsed = parseRedemptionJournal(JSON.parse(content.toString("utf8")) as unknown);
    return parsed && redemptionStateTargetsProfileId(parsed, input.profileId)
      ? { kind: "journal", journal: parsed }
      : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}
