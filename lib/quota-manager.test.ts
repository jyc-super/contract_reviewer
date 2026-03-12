import { describe, it, expect } from "vitest";
import { canCall, recordCall, getRemaining } from "./quota-manager";

describe("quota-manager", () => {
  it("getRemaining returns all model keys with used, limit, resetAt", async () => {
    const remaining = await getRemaining();
    const keys = [
      "flash31Lite",
      "flash25",
      "flash25Lite",
      "flash3",
      "gemma27b",
      "gemma12b",
      "gemma4b",
      "embedding",
    ] as const;
    for (const key of keys) {
      expect(remaining).toHaveProperty(key);
      expect(remaining[key]).toMatchObject({
        used: expect.any(Number),
        limit: expect.any(Number),
        resetAt: expect.any(Date),
      });
      expect(remaining[key].used).toBeGreaterThanOrEqual(0);
      expect(remaining[key].limit).toBeGreaterThanOrEqual(0);
    }
  });

  it("canCall returns boolean", async () => {
    const result = await canCall("flash31Lite");
    expect(typeof result).toBe("boolean");
  });

  it("recordCall does not throw", async () => {
    await expect(recordCall("flash31Lite")).resolves.toBeUndefined();
  });
});
