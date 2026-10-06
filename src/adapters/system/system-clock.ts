import type { Clock } from "../../ports/clock.js";

export const systemClock: Clock = {
  now: (): Date => new Date(),
  monotonicNow: (): number => performance.now(),
};
