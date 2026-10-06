import { describe, expect, it } from "vitest";
import {
  type AttemptOutcome,
  MAX_RETRY_AFTER_MS,
  type RetryPolicy,
  runWithRetries,
} from "../../../../src/adapters/openai/retry-policy.js";

interface Script {
  readonly attempt: () => Promise<AttemptOutcome<string>>;
  readonly calls: () => number;
}

interface RecordingPolicy {
  readonly sleeps: number[];
  readonly policy: RetryPolicy;
}

function script(outcomes: readonly AttemptOutcome<string>[]): Script {
  let calls = 0;

  return {
    attempt: async () => {
      const outcome = outcomes[calls] ?? outcomes.at(-1);
      calls += 1;

      if (outcome === undefined) {
        throw new Error("empty script");
      }

      return outcome;
    },
    calls: () => calls,
  };
}

const TRANSIENT: AttemptOutcome<string> = { retry: true, value: "failed", retryAfterMs: undefined };

const DONE: AttemptOutcome<string> = { retry: false, value: "done" };

function policy(maxRetries: number, random = 0.5): RecordingPolicy {
  const sleeps: number[] = [];

  return {
    sleeps,
    policy: {
      maxRetries,
      random: () => random,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  };
}

const idle = (): AbortSignal => new AbortController().signal;

describe("runWithRetries", () => {
  it("returns a final outcome at once", async () => {
    const { attempt, calls } = script([DONE]);
    const { policy: retry, sleeps } = policy(3);

    expect(await runWithRetries(attempt, retry, idle())).toEqual({ value: "done", attempts: 1 });
    expect(calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("makes at most maxRetries + 1 attempts and returns the last failure", async () => {
    const { attempt, calls } = script([TRANSIENT]);
    const { policy: retry } = policy(2);

    expect(await runWithRetries(attempt, retry, idle())).toEqual({ value: "failed", attempts: 3 });
    expect(calls()).toBe(3);
  });

  it("grows the backoff exponentially with full jitter, capped at 8 s", async () => {
    const { attempt } = script([TRANSIENT]);
    const { policy: retry, sleeps } = policy(6, 0.999_999);

    await runWithRetries(attempt, retry, idle());

    expect(sleeps).toEqual([499, 999, 1_999, 3_999, 7_999, 7_999]);
  });

  it("can wait zero milliseconds when the jitter draws zero", async () => {
    const { attempt } = script([TRANSIENT, DONE]);
    const { policy: retry, sleeps } = policy(2, 0);

    await runWithRetries(attempt, retry, idle());

    expect(sleeps).toEqual([0]);
  });

  it("uses a server-requested wait up to the cap and stops retrying above it", async () => {
    const atCap = script([{ ...TRANSIENT, retryAfterMs: MAX_RETRY_AFTER_MS }, DONE]);
    const overCap = script([{ ...TRANSIENT, retryAfterMs: MAX_RETRY_AFTER_MS + 1 }, DONE]);
    const first = policy(2);
    const second = policy(2);

    expect(await runWithRetries(atCap.attempt, first.policy, idle())).toEqual({
      value: "done",
      attempts: 2,
    });
    expect(first.sleeps).toEqual([MAX_RETRY_AFTER_MS]);
    expect(await runWithRetries(overCap.attempt, second.policy, idle())).toEqual({
      value: "failed",
      attempts: 1,
    });
    expect(second.sleeps).toEqual([]);
  });

  it("propagates an aborted wait and makes no further attempt", async () => {
    const controller = new AbortController();
    const { attempt, calls } = script([TRANSIENT]);

    const pending = runWithRetries(
      attempt,
      {
        maxRetries: 3,
        random: () => 0.5,
        sleep: async (_ms, signal) => {
          controller.abort();
          signal.throwIfAborted();
        },
      },
      controller.signal,
    );

    await expect(pending).rejects.toBeDefined();
    expect(calls()).toBe(1);
  });
});
