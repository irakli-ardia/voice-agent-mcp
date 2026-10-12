import { describe, expect, it } from "vitest";
import {
  type Admission,
  createCallAdmission,
} from "../../../../src/adapters/mcp/call-admission.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import { createRecordingLogger } from "../../../helpers/recording-logger.js";

function setup(maxCallsPerSecond = 20, maxInFlightCalls = 16) {
  const clock = createFakeClock();
  const logger = createRecordingLogger();
  const admission = createCallAdmission({ clock, logger, maxCallsPerSecond, maxInFlightCalls });

  return { clock, logger, admission };
}

type Granted = Extract<Admission, { readonly ok: true }>;

function granted(result: Admission): Granted {
  if (!result.ok) {
    throw new Error(`Expected the call to be admitted, got ${result.reason}.`);
  }

  return result;
}

/** Admits and releases at once, so only the rate limit decides. */
function admitAndRelease(admission: { admit(): Admission }): string {
  const result = admission.admit();

  if (result.ok) {
    result.release();

    return "ok";
  }

  return result.reason;
}

function exhaust(admission: { admit(): Admission }, calls = 20): void {
  for (let call = 0; call < calls; call += 1) {
    admitAndRelease(admission);
  }
}

describe("createCallAdmission: token bucket", () => {
  it("admits a full burst of 20, then refuses with rate_limited", () => {
    const { admission } = setup();

    const results = Array.from({ length: 21 }, () => admitAndRelease(admission));

    expect(results.slice(0, 20)).toEqual(Array(20).fill("ok"));
    expect(results[20]).toBe("rate_limited");
  });

  it("refills at the configured rate: one token every 50 ms at 20 per second", () => {
    const { admission, clock } = setup();

    exhaust(admission);
    clock.advance(49);

    expect(admitAndRelease(admission)).toBe("rate_limited");

    clock.advance(1);

    expect(admitAndRelease(admission)).toBe("ok");
    expect(admitAndRelease(admission)).toBe("rate_limited");
  });

  it("refills in proportion to elapsed time, however it is split", () => {
    const { admission, clock } = setup();

    exhaust(admission);

    // 500 ms in ten steps is ten tokens, no more and no fewer.
    for (let step = 0; step < 10; step += 1) {
      clock.advance(50);
    }

    const admitted = Array.from({ length: 12 }, () => admitAndRelease(admission));

    expect(admitted.filter((result) => result === "ok")).toHaveLength(10);
  });

  it("never holds more than one second of tokens, however long it was idle", () => {
    const { admission, clock } = setup();

    clock.advance(3_600_000);

    const results = Array.from({ length: 25 }, () => admitAndRelease(admission));

    expect(results.filter((result) => result === "ok")).toHaveLength(20);
  });

  it("recovers fully after being exhausted and left alone for a second", () => {
    const { admission, clock } = setup();

    exhaust(admission, 30);
    clock.advance(1_000);

    const results = Array.from({ length: 21 }, () => admitAndRelease(admission));

    expect(results.filter((result) => result === "ok")).toHaveLength(20);
  });

  it("scales with the configured rate: 1 per second means a burst of one", () => {
    const { admission, clock } = setup(1);

    expect(admitAndRelease(admission)).toBe("ok");
    expect(admitAndRelease(admission)).toBe("rate_limited");

    clock.advance(999);

    expect(admitAndRelease(admission)).toBe("rate_limited");

    clock.advance(1);

    expect(admitAndRelease(admission)).toBe("ok");
  });

  it("handles the top of the range: 1000 per second refills one token per millisecond", () => {
    const { admission, clock } = setup(1_000);

    for (let call = 0; call < 1_000; call += 1) {
      expect(admitAndRelease(admission)).toBe("ok");
    }

    expect(admitAndRelease(admission)).toBe("rate_limited");

    clock.advance(1);

    expect(admitAndRelease(admission)).toBe("ok");
  });

  it("counts fractional milliseconds exactly", () => {
    const { admission, clock } = setup();

    exhaust(admission);
    clock.advance(24.5);
    clock.advance(25.5);

    expect(admitAndRelease(admission)).toBe("ok");
  });

  it("does not refill when the clock reads the same or earlier", () => {
    const clock = createFakeClock();
    let reading = 100;

    const admission = createCallAdmission({
      clock: { ...clock, monotonicNow: () => reading },
      logger: createRecordingLogger(),
      maxCallsPerSecond: 20,
      maxInFlightCalls: 16,
    });

    exhaust(admission);

    reading = 50;

    expect(admitAndRelease(admission)).toBe("rate_limited");

    reading = 100;

    expect(admitAndRelease(admission)).toBe("rate_limited");
  });

  it("does not let a refused call delay recovery or change the bucket", () => {
    const { admission, clock } = setup();

    exhaust(admission);

    for (let refused = 0; refused < 500; refused += 1) {
      expect(admitAndRelease(admission)).toBe("rate_limited");
    }

    clock.advance(50);

    expect(admitAndRelease(admission)).toBe("ok");
    expect(admitAndRelease(admission)).toBe("rate_limited");
  });
});

describe("createCallAdmission: admission ordering and in-flight accounting", () => {
  it("refuses over the in-flight cap with server_busy and frees the slot on release", () => {
    const { admission } = setup(1_000, 2);
    const first = granted(admission.admit());

    granted(admission.admit());

    expect(admission.admit()).toEqual({ ok: false, reason: "server_busy" });

    first.release();

    expect(admission.admit().ok).toBe(true);
  });

  it("takes a token for a call the in-flight cap refuses: busy refusals are not free", () => {
    const { admission, clock } = setup(20, 1);
    const held = granted(admission.admit());

    // 19 tokens remain; every busy refusal takes one.
    for (let call = 0; call < 19; call += 1) {
      expect(admission.admit()).toEqual({ ok: false, reason: "server_busy" });
    }

    held.release();

    expect(admission.admit()).toEqual({ ok: false, reason: "rate_limited" });

    clock.advance(50);

    expect(admission.admit().ok).toBe(true);
  });

  it("checks the rate before the in-flight cap", () => {
    const { admission } = setup(1, 1);

    granted(admission.admit());

    // No token left and no slot left: the rate limit is what answers.
    expect(admission.admit()).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("does not take an in-flight slot for a call refused by the rate limit", () => {
    const { admission, clock } = setup(1, 1);

    granted(admission.admit()).release();

    expect(admission.admit()).toEqual({ ok: false, reason: "rate_limited" });

    clock.advance(1_000);

    expect(admission.admit().ok).toBe(true);
  });

  it("makes release idempotent: a second release frees nothing more", () => {
    const { admission } = setup(1_000, 2);
    const first = granted(admission.admit());

    granted(admission.admit());
    first.release();
    first.release();
    first.release();

    granted(admission.admit());

    expect(admission.admit()).toEqual({ ok: false, reason: "server_busy" });
  });

  it("never admits more than the cap when many calls arrive in the same turn", () => {
    const { admission } = setup(1_000, 16);
    const results = Array.from({ length: 200 }, () => admission.admit());

    expect(results.filter((result) => result.ok)).toHaveLength(16);
    expect(results.filter((result) => !result.ok)).toHaveLength(184);
  });

  it("returns to an exact count after any mix of admissions and releases", () => {
    const { admission } = setup(1_000, 4);
    const held: Granted[] = [];

    for (let round = 0; round < 50; round += 1) {
      const result = admission.admit();

      if (result.ok) {
        held.push(result);
      }

      if (round % 3 === 0) {
        held.shift()?.release();
      }
    }

    for (const slot of held) {
      slot.release();
    }

    const results = Array.from({ length: 4 }, () => admission.admit());

    expect(results.every((result) => result.ok)).toBe(true);
    expect(admission.admit()).toEqual({ ok: false, reason: "server_busy" });
  });
});

describe("createCallAdmission: logging", () => {
  it("logs nothing while calls are admitted or refused as busy", () => {
    const { admission, logger } = setup(1_000, 1);

    granted(admission.admit());
    admission.admit();

    expect(logger.entries).toEqual([]);
  });

  it("logs the first rate-limited call at once, with counts only", () => {
    const { admission, logger } = setup(1, 1);

    admitAndRelease(admission);
    admitAndRelease(admission);

    expect(logger.entries).toEqual([
      { level: "warn", message: "mcp.rate_limited", fields: { refused: 1, callsPerSecond: 1 } },
    ]);
  });

  it("logs at most once a second, then reports every refusal since the last line", () => {
    const { admission, logger, clock } = setup(1, 1);

    admitAndRelease(admission);

    // Refusals at 0, 100, ..., 900 ms: only the first is logged.
    for (let refused = 0; refused < 10; refused += 1) {
      admitAndRelease(admission);
      clock.advance(100);
    }

    expect(logger.entries).toHaveLength(1);

    // At exactly 1 000 ms the bucket has refilled, so spend its token; the next refusal is the
    // first one on or after the one-second mark and reports the nine it skipped, plus itself.
    admitAndRelease(admission);
    admitAndRelease(admission);

    expect(logger.entries).toHaveLength(2);
    expect(logger.entries[1]?.fields).toEqual({ refused: 10, callsPerSecond: 1 });
  });

  it("does not log one millisecond before the second is up", () => {
    const { admission, logger, clock } = setup(2, 1);

    exhaust(admission, 2);
    admitAndRelease(admission);

    expect(logger.entries).toHaveLength(1);

    clock.advance(499);
    admitAndRelease(admission);

    expect(logger.entries).toHaveLength(1);
  });

  it("never logs a value a client controls: only two numbers", () => {
    const { admission, logger } = setup(1, 1);

    admitAndRelease(admission);
    admitAndRelease(admission);

    for (const entry of logger.entries) {
      expect(entry.fields).toEqual({
        refused: expect.any(Number),
        callsPerSecond: expect.any(Number),
      });
    }
  });
});

describe("createCallAdmission: closing", () => {
  it("refuses every call after close with shutting_down, even with tokens and slots free", () => {
    const { admission } = setup();

    admission.close();

    expect(admission.admit()).toEqual({ ok: false, reason: "shutting_down" });
    expect(admission.admit()).toEqual({ ok: false, reason: "shutting_down" });
  });

  it("changes nothing for calls already admitted: they run on and release as usual", () => {
    const { admission } = setup(20, 1);
    const running = granted(admission.admit());

    admission.close();
    running.release();
    running.release();

    expect(admission.admit()).toEqual({ ok: false, reason: "shutting_down" });
  });

  it("takes no token and no slot for a call it refuses, and logs nothing", () => {
    const { admission, logger } = setup(2, 1);

    admission.close();

    for (let call = 0; call < 10; call += 1) {
      admission.admit();
    }

    expect(logger.entries).toEqual([]);
  });

  it("is idempotent", () => {
    const { admission } = setup();

    admission.close();
    admission.close();

    expect(admission.admit()).toEqual({ ok: false, reason: "shutting_down" });
  });
});
