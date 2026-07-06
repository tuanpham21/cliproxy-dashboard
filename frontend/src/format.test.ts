import { describe, expect, it } from "vitest";

import { escapeHtml, inferPlan, quotaStatusClass, quotaUsageClass, resetLabel } from "./format";

describe("frontend formatting helpers", () => {
  it("escapes HTML inserted into render strings", () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
    );
  });

  it("infers plan names from Proxy Account filenames", () => {
    expect(inferPlan("codex-user@example.com-plus.json")).toBe("plus");
    expect(inferPlan("codex-user@example.com-free.json.disabled")).toBe("free");
  });

  it("classifies quota usage and refresh-needed status without implying current availability", () => {
    expect(quotaUsageClass(92)).toBe("bad");
    expect(quotaUsageClass(75)).toBe("warn");
    expect(quotaUsageClass(25)).toBe("good");
    expect(quotaStatusClass("refresh-needed")).toBe("warn");
  });

  it("labels reset times that have already passed", () => {
    expect(resetLabel("2026-01-01T00:00:00.000Z", Date.parse("2026-01-02T00:00:00.000Z"))).toBe(
      "Reset passed",
    );
  });
});
