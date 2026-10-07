import { setTimeout as delay } from "node:timers/promises";

/** Waits `milliseconds`; rejects as soon as `signal` aborts. The retry policies' sleep. */
export async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal });
}
