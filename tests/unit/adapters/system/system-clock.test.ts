import { describe, expect, it } from "vitest";
import { systemClock } from "../../../../src/adapters/system/system-clock.js";

describe("systemClock", () => {
  it("reads the current wall-clock time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("gives monotonic readings that never go backwards", () => {
    const first = systemClock.monotonicNow();
    expect(systemClock.monotonicNow()).toBeGreaterThanOrEqual(first);
  });
});
