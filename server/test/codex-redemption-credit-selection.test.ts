import { describe, expect, it } from "vitest";

import { selectCodexResetCredit } from "../codex-redemption-credit-selection.js";

describe("Codex reset-credit server selection", () => {
  it("selects earliest-expiring fresh usable credit and leaves generic availability provider-selected", () => {
    const credits = [
      { id: "later", availability: "available" as const, title: "Later", description: null, expiresAt: 2_000 },
      { id: "no-expiry", availability: "available" as const, title: "No expiry", description: null, expiresAt: null },
      { id: "earlier", availability: "available" as const, title: "Earlier", description: null, expiresAt: 1_000 },
    ];

    expect(selectCodexResetCredit(credits, undefined, true)?.id).toBe("earlier");
    expect(selectCodexResetCredit([], undefined)).toBeNull();
    expect(selectCodexResetCredit(credits, "missing")).toBeUndefined();
    expect(selectCodexResetCredit([
      { ...credits[0]!, id: "duplicate" },
      { ...credits[2]!, id: "duplicate" },
    ], undefined, true)).toBeUndefined();
  });
});
