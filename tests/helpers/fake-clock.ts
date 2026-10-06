import type { Clock } from "../../src/ports/clock.js";

export interface FakeClock extends Clock {
  advance(milliseconds: number): void;
}

/** A clock that moves only when the test advances it. */
export function createFakeClock(start = new Date("2026-01-02T03:04:05.000Z")): FakeClock {
  let elapsed = 0;

  return {
    now: (): Date => new Date(start.getTime() + elapsed),
    monotonicNow: (): number => elapsed,
    advance: (milliseconds: number): void => {
      elapsed += milliseconds;
    },
  };
}
