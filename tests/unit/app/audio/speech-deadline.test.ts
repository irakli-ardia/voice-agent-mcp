import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSpeechDeadline } from "../../../../src/app/audio/speech-deadline.js";
import { untilAborted } from "../../../helpers/until-aborted.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  const leakedTimers = vi.getTimerCount();
  vi.useRealTimers();

  if (leakedTimers > 0) {
    throw new Error(`The test left ${leakedTimers} timer(s) running.`);
  }
});

describe("speech deadline", () => {
  it("runs until the deadline, then reports timed_out and aborts its signal", () => {
    const deadline = startSpeechDeadline(new AbortController().signal, 1_000);

    vi.advanceTimersByTime(999);
    expect(deadline.stopped()).toBeUndefined();
    expect(deadline.signal.aborted).toBe(false);

    vi.advanceTimersByTime(1);
    expect(deadline.stopped()).toBe("timed_out");
    expect(deadline.signal.aborted).toBe(true);
  });

  it("reports cancelled when the caller aborts, and lets the caller win over the deadline", () => {
    const caller = new AbortController();
    const deadline = startSpeechDeadline(caller.signal, 1_000);

    vi.advanceTimersByTime(1_000);
    caller.abort();

    expect(deadline.stopped()).toBe("cancelled");
  });

  it("starts already stopped for an aborted caller", () => {
    const caller = new AbortController();

    caller.abort();

    const deadline = startSpeechDeadline(caller.signal, 1_000);

    expect(deadline.stopped()).toBe("cancelled");
    expect(deadline.signal.aborted).toBe(true);
    deadline.clear();
  });

  it("stops its timer on clear", () => {
    const deadline = startSpeechDeadline(new AbortController().signal, 1_000);

    deadline.clear();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    expect(deadline.stopped()).toBeUndefined();
  });

  it("returns a step's value while the operation runs", async () => {
    const deadline = startSpeechDeadline(new AbortController().signal, 1_000);

    expect(await deadline.step(async () => 7)).toEqual({ ok: true, value: 7 });
    deadline.clear();
  });

  it("turns a step's rejection after an abort into the stop reason", async () => {
    const deadline = startSpeechDeadline(new AbortController().signal, 1_000);
    const step = deadline.step(async () => untilAborted(deadline.signal));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await step).toEqual({ ok: false, error: "timed_out" });
  });

  it("reports a rejection without an abort as a broken port contract", async () => {
    const deadline = startSpeechDeadline(new AbortController().signal, 1_000);

    expect(await deadline.step(async () => Promise.reject(new Error("broken")))).toEqual({
      ok: false,
      error: "rejected_without_abort",
    });
    expect(await deadline.commit(() => Promise.reject(new Error("broken")))).toEqual({
      ok: false,
      error: "rejected_without_abort",
    });
    deadline.clear();
  });

  it("drops a step's value when the operation stopped while it ran", async () => {
    const caller = new AbortController();
    const deadline = startSpeechDeadline(caller.signal, 1_000);

    const step = await deadline.step(async () => {
      caller.abort();

      return 7;
    });

    expect(step).toEqual({ ok: false, error: "cancelled" });
    deadline.clear();
  });

  it("keeps a commit's value even when the operation stopped while it ran", async () => {
    const caller = new AbortController();
    const deadline = startSpeechDeadline(caller.signal, 1_000);

    const committed = await deadline.commit(async () => {
      caller.abort();

      return 7;
    });

    expect(committed).toEqual({ ok: true, value: 7 });
    deadline.clear();
  });

  it("catches a synchronous throw from the port call", async () => {
    const deadline = startSpeechDeadline(new AbortController().signal, 1_000);

    const outcome = await deadline.step((): Promise<number> => {
      throw new Error("thrown before a promise existed");
    });

    expect(outcome).toEqual({ ok: false, error: "rejected_without_abort" });
    deadline.clear();
  });
});
