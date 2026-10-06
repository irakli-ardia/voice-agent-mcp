/** One attempt's result: final, or retryable with the value to use if no retry is left. */
export type AttemptOutcome<T> =
  | { readonly retry: false; readonly value: T }
  | { readonly retry: true; readonly value: T; readonly retryAfterMs: number | undefined };

export interface RetryPolicy {
  /** Retries after the first attempt; 0 disables retrying. */
  readonly maxRetries: number;
  /** Uniform in [0, 1); injected so tests are deterministic. */
  readonly random: () => number;
  /** Waits `ms`; rejects when `signal` aborts. */
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

const BASE_DELAY_MS = 500;

const MAX_DELAY_MS = 8_000;

/** A server-requested wait longer than this ends retrying instead of stalling the turn. */
export const MAX_RETRY_AFTER_MS = 10_000;

/**
 * Runs `attempt` until it is final or the retries are spent. Backoff is full jitter over
 * `min(8 s, 500 ms × 2^retry)`; a server-requested wait up to 10 s replaces it, and a longer one
 * ends retrying. Every wait stops when `signal` aborts (the rejection propagates). Bounded by
 * `maxRetries`; it never retries on its own judgement, only when `attempt` says the failure is
 * transient.
 */
export async function runWithRetries<T>(
  attempt: () => Promise<AttemptOutcome<T>>,
  policy: RetryPolicy,
  signal: AbortSignal,
): Promise<{ readonly value: T; readonly attempts: number }> {
  for (let retry = 0; ; retry += 1) {
    const outcome = await attempt();
    const attempts = retry + 1;

    if (!outcome.retry || retry >= policy.maxRetries) {
      return { value: outcome.value, attempts };
    }

    if (outcome.retryAfterMs !== undefined && outcome.retryAfterMs > MAX_RETRY_AFTER_MS) {
      return { value: outcome.value, attempts };
    }

    const backoff = Math.floor(
      policy.random() * Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** retry),
    );

    await policy.sleep(outcome.retryAfterMs ?? backoff, signal);
  }
}
