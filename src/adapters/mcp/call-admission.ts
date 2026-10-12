import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";

export interface CallAdmissionOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  /** Sustained rate and burst capacity: the bucket holds one second of calls. */
  readonly maxCallsPerSecond: number;
  /** Admitted calls that may be running at once. */
  readonly maxInFlightCalls: number;
}

/** Why a call was refused. No reason reaches the executor, so no handler runs. */
export type RefusalReason = "rate_limited" | "server_busy" | "shutting_down";

export type Admission =
  | {
      readonly ok: true;
      /** Frees the in-flight slot; safe to call more than once. */
      release(): void;
    }
  | { readonly ok: false; readonly reason: RefusalReason };

export interface CallAdmission {
  admit(): Admission;
  /**
   * Refuses every later call with `shutting_down`, without touching the bucket or the in-flight
   * count; calls already admitted run on and release as usual. Idempotent, and not reversible.
   */
  close(): void;
}

/** The most often the rate limit logs; refusals in between are counted into the next line. */
const LOG_INTERVAL_MS = 1_000;

const MILLI = 1_000;

/**
 * Decides whether a `tools/call` may reach the executor: a token bucket, then an in-flight cap.
 *
 * - The bucket starts full with `maxCallsPerSecond` tokens, refills continuously at that rate from
 *   the injected clock, and never holds more. Tokens are counted in thousandths, so a refill is
 *   `elapsed milliseconds × rate`, exactly.
 * - Every call that finds a token takes it, **including one that the in-flight cap then refuses**:
 *   a flood of busy refusals is not free. A call refused for lack of a token takes nothing and
 *   changes nothing else.
 * - A call that passes both holds one in-flight slot until `release`, which frees it once however
 *   often it is called.
 *
 * Memory is constant: two numbers for the bucket, one counter, and the throttle's two numbers. It
 * keeps nothing about a call, and logs only counts: never arguments, names, ids, or keys.
 */
export function createCallAdmission(options: CallAdmissionOptions): CallAdmission {
  const { clock, logger, maxCallsPerSecond, maxInFlightCalls } = options;
  const capacity = maxCallsPerSecond * MILLI;
  let tokens = capacity;
  let refilledAt = clock.monotonicNow();
  let inFlight = 0;
  let refusedSinceLog = 0;
  let loggedAt: number | undefined;
  let closed = false;

  const refill = (): number => {
    const now = clock.monotonicNow();

    if (now > refilledAt) {
      tokens = Math.min(capacity, tokens + (now - refilledAt) * maxCallsPerSecond);
      refilledAt = now;
    }

    return now;
  };

  const reportRateLimited = (now: number): void => {
    refusedSinceLog += 1;

    if (loggedAt !== undefined && now - loggedAt < LOG_INTERVAL_MS) {
      return;
    }

    logger.warn("mcp.rate_limited", {
      refused: refusedSinceLog,
      callsPerSecond: maxCallsPerSecond,
    });
    refusedSinceLog = 0;
    loggedAt = now;
  };

  return {
    close: (): void => {
      closed = true;
    },
    admit: (): Admission => {
      if (closed) {
        return { ok: false, reason: "shutting_down" };
      }

      const now = refill();

      if (tokens < MILLI) {
        reportRateLimited(now);

        return { ok: false, reason: "rate_limited" };
      }

      tokens -= MILLI;

      // Check and increment run in one synchronous step, so concurrent requests cannot oversubscribe.
      if (inFlight >= maxInFlightCalls) {
        return { ok: false, reason: "server_busy" };
      }

      inFlight += 1;

      let released = false;

      return {
        ok: true,
        release: (): void => {
          if (!released) {
            released = true;
            inFlight -= 1;
          }
        },
      };
    },
  };
}
