import { describe, expect, it, vi } from "vitest";

import { getOperatorToken } from "./api";

describe("frontend API bootstrap", () => {
  it("does not permanently cache a transient bootstrap failure", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend not ready"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ operatorToken: "retry-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOperatorToken()).rejects.toThrow("backend not ready");
    await expect(getOperatorToken()).resolves.toBe("retry-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
