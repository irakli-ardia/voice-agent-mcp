import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createFlowControlledOutput,
  type FlowControlledOutput,
  OUTPUT_HIGH_WATER_MARK,
} from "../../../src/bootstrap/flow-controlled-output.js";

interface Pending {
  readonly chunk: Buffer;
  readonly callback: (error?: Error | null) => void;
}

/** A target that holds every write until the test flushes it: a reader that is not reading. */
function stalledTarget() {
  const pending: Pending[] = [];
  const received: Buffer[] = [];

  const target = new Writable({
    highWaterMark: 1,
    write: (chunk: Buffer, _encoding, callback): void => {
      pending.push({ chunk, callback });
    },
  });

  return {
    target,
    received,
    pendingCount: (): number => pending.length,
    /** Completes the oldest `count` held writes, as a reader catching up would. */
    flush: (count = pending.length): void => {
      for (const item of pending.splice(0, count)) {
        received.push(item.chunk);
        item.callback();
      }
    },
  };
}

/** An input that is flowing, as stdin is while the transport listens to it. */
function flowingInput() {
  const input = new PassThrough();

  input.on("data", () => {});

  return { input, pause: vi.spyOn(input, "pause"), resume: vi.spyOn(input, "resume") };
}

const KIB = 1_024;

/** No practical limit: the tests of the pause and resume rules are not about the limit. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

function openOutput(
  target: Writable,
  input: PassThrough,
  maxQueuedBytes = NO_LIMIT,
  onOverflow: () => void = () => {},
): FlowControlledOutput {
  return createFlowControlledOutput(target, input, { maxQueuedBytes, onOverflow });
}

function chunkOf(size: number, fill = 97): Buffer {
  return Buffer.alloc(size, fill);
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createFlowControlledOutput", () => {
  it("passes bytes through untouched and in order", async () => {
    const sink = new PassThrough();
    const { input } = flowingInput();
    const output = openOutput(sink, input);
    const received: Buffer[] = [];

    sink.on("data", (chunk: Buffer) => received.push(chunk));
    output.stream.write('{"a":1}\n');
    output.stream.write('{"b":2}\n');
    output.stream.write(Buffer.from('{"c":3}\n'));
    await turn();

    expect(Buffer.concat(received).toString()).toBe('{"a":1}\n{"b":2}\n{"c":3}\n');
  });

  it("writes to the target one chunk at a time, each whole, in the order it was given", () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);
    const chunks = [chunkOf(10, 97), chunkOf(20, 98), chunkOf(30, 99)];

    for (const chunk of chunks) {
      output.stream.write(chunk);
    }

    expect(stalled.pendingCount()).toBe(1);

    stalled.flush();
    stalled.flush();
    stalled.flush();

    expect(stalled.received).toEqual(chunks);
  });

  it("does not touch the input while the output keeps up", async () => {
    const sink = new PassThrough();
    const { input, pause, resume } = flowingInput();
    const output = openOutput(sink, input);

    sink.resume();

    for (let index = 0; index < 100; index += 1) {
      output.stream.write(chunkOf(KIB));
      await turn();
    }

    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it("pauses the input exactly when the queued bytes reach the mark", () => {
    const stalled = stalledTarget();
    const { input, pause } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK - 1));

    expect(pause).not.toHaveBeenCalled();
    expect(input.isPaused()).toBe(false);

    output.stream.write(chunkOf(1));

    expect(pause).toHaveBeenCalledTimes(1);
    expect(input.isPaused()).toBe(true);
  });

  it("counts the chunk being written to the target as still queued", () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK));

    // One chunk, handed to the target but not yet completed: the output is already full.
    expect(stalled.pendingCount()).toBe(1);
    expect(input.isPaused()).toBe(true);
  });

  it("resumes the input once, when the queue falls below the mark", () => {
    const stalled = stalledTarget();
    const { input, resume } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(40 * KIB));
    output.stream.write(chunkOf(40 * KIB));

    expect(input.isPaused()).toBe(true);

    // 80 KiB queued: after the first completes, 40 KiB remain, below the mark.
    stalled.flush(1);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(input.isPaused()).toBe(false);

    stalled.flush();

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("stays paused while the queue is still at or above the mark", () => {
    const stalled = stalledTarget();
    const { input, resume } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK));
    output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK));
    stalled.flush(1);

    expect(resume).not.toHaveBeenCalled();
    expect(input.isPaused()).toBe(true);

    stalled.flush();

    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("pauses again after resuming, as often as the output backs up", () => {
    const stalled = stalledTarget();
    const { input, pause, resume } = flowingInput();
    const output = openOutput(stalled.target, input);

    for (let round = 0; round < 3; round += 1) {
      output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK));
      stalled.flush();
    }

    expect(pause).toHaveBeenCalledTimes(3);
    expect(resume).toHaveBeenCalledTimes(3);
  });

  it("holds a reader that never reads to one write in flight, and pauses the input once", async () => {
    const stalled = stalledTarget();
    const { input, pause, resume } = flowingInput();
    const output = openOutput(stalled.target, input);

    // What a transport does after the pause: only the input chunk already read is still answered.
    for (let index = 0; index < 40; index += 1) {
      output.stream.write(chunkOf(4 * KIB));
    }

    for (let index = 0; index < 20; index += 1) {
      await turn();
    }

    expect(stalled.pendingCount()).toBe(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(input.isPaused()).toBe(true);
  });

  it("accepts every write at once, so the transport is never made to wait for a drain", () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);

    expect(output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK * 4))).toBe(true);
    expect(output.stream.writableNeedDrain).toBe(false);
  });

  it("delivers everything, whole and in order, to a slow reader", async () => {
    const received: Buffer[] = [];

    const slow = new Writable({
      highWaterMark: 1,
      write: (chunk: Buffer, _encoding, callback): void => {
        received.push(chunk);
        setTimeout(callback, 1);
      },
    });

    const { input, pause, resume } = flowingInput();
    const output = openOutput(slow, input);

    const lines = Array.from({ length: 60 }, (_, index) =>
      `{"id":${index}}\n`.padEnd(4 * KIB, " "),
    );

    for (const line of lines) {
      output.stream.write(line);
      await turn();
    }

    // The reader catches up while the connection is still open: that is when the input is resumed.
    while (received.length < lines.length) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const finished = new Promise((resolve) => output.stream.once("finish", resolve));

    output.finish();
    await finished;

    expect(Buffer.concat(received).toString()).toBe(lines.join(""));
    expect(pause.mock.calls.length).toBeGreaterThan(0);
    expect(resume.mock.calls.length).toBeGreaterThan(0);
    expect(input.isPaused()).toBe(false);
  });

  it("flushes everything queued before it reports finished", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);
    let done = false;

    output.stream.once("finish", () => {
      done = true;
    });
    output.stream.write(chunkOf(KIB));
    output.stream.write(chunkOf(KIB));
    output.finish();
    await turn();

    expect(done).toBe(false);

    stalled.flush(1);
    await turn();

    expect(done).toBe(false);

    stalled.flush();
    await turn();

    expect(done).toBe(true);
    expect(stalled.received).toHaveLength(2);
  });

  it("finishes at once when nothing is queued", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);
    const finished = new Promise((resolve) => output.stream.once("finish", resolve));

    output.finish();

    await expect(finished).resolves.toBeUndefined();
  });

  it("no longer touches the input once finished", () => {
    const stalled = stalledTarget();
    const { input, pause, resume } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK));
    output.finish();

    expect(pause).toHaveBeenCalledTimes(1);

    stalled.flush();

    expect(resume).not.toHaveBeenCalled();
  });

  it("does not pause the input for a write made after finish", () => {
    const stalled = stalledTarget();
    const { input, pause } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.finish();
    output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK));
    output.stream.write(chunkOf(OUTPUT_HIGH_WATER_MARK));

    expect(pause).not.toHaveBeenCalled();
  });

  it("surfaces an error of the real output on the wrapper, for the transport to handle", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);
    const seen = Promise.withResolvers<Error>();

    output.stream.once("error", (error: Error) => seen.resolve(error));
    stalled.target.destroy(new Error("EPIPE"));

    expect((await seen.promise).message).toBe("EPIPE");
  });

  it("surfaces a failed write on the wrapper and stops writing", async () => {
    const written: string[] = [];

    const failing = new Writable({
      write: (chunk: Buffer, _encoding, callback): void => {
        written.push(chunk.toString());
        callback(new Error("write failed"));
      },
    });

    const { input } = flowingInput();
    const output = openOutput(failing, input);
    const seen = Promise.withResolvers<Error>();

    output.stream.once("error", (error: Error) => seen.resolve(error));
    output.stream.write("first");
    output.stream.write("second");

    expect((await seen.promise).message).toBe("write failed");
    expect(output.stream.destroyed).toBe(true);
    expect(written).toEqual(["first"]);
  });

  it("does not crash on an error that arrives with nothing listening", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();

    openOutput(stalled.target, input);
    stalled.target.destroy(new Error("late EPIPE"));
    await turn();
    await turn();

    expect(stalled.target.destroyed).toBe(true);
  });

  it("ignores errors of the real output once finished", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);
    const errors: Error[] = [];

    output.stream.on("error", (error: Error) => errors.push(error));
    output.finish();
    stalled.target.on("error", () => {});
    stalled.target.destroy(new Error("after finish"));
    await turn();

    expect(errors).toEqual([]);
  });

  it("keeps every byte of a long mixed run, whole and in order", async () => {
    const sink = new PassThrough();
    const { input } = flowingInput();
    const output = openOutput(sink, input);
    const received: Buffer[] = [];
    const sent: Buffer[] = [];
    let seed = 7;

    sink.on("data", (chunk: Buffer) => received.push(chunk));

    for (let index = 0; index < 300; index += 1) {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;

      const chunk = chunkOf(1 + (seed % (9 * KIB)), 97 + (index % 20));

      sent.push(chunk);
      output.stream.write(chunk);

      if (index % 7 === 0) {
        await turn();
      }
    }

    const finished = new Promise((resolve) => output.stream.once("finish", resolve));

    output.finish();
    await finished;
    await turn();

    expect(Buffer.concat(received).equals(Buffer.concat(sent))).toBe(true);
  });
});

describe("createFlowControlledOutput: the enforced queue limit", () => {
  const OVERFLOW = "The output queue limit was exceeded.";

  function watched(output: FlowControlledOutput) {
    const errors: Error[] = [];

    output.stream.on("error", (error: Error) => errors.push(error));

    return errors;
  }

  it("accepts writes up to exactly the limit and refuses the first byte past it", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 1_000);
    const errors = watched(output);

    output.stream.write(chunkOf(600));
    output.stream.write(chunkOf(400));

    expect(output.queuedBytes()).toBe(1_000);
    expect(errors).toEqual([]);

    output.stream.write(chunkOf(1));
    await turn();

    expect(errors.map((error) => error.message)).toEqual([OVERFLOW]);
  });

  it("counts the chunk being written to the target, not only the ones waiting", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 1_000);
    const errors = watched(output);

    output.stream.write(chunkOf(600));

    // 600 are with the target, 0 waiting: a 500-byte chunk still passes the limit.
    expect(stalled.pendingCount()).toBe(1);
    output.stream.write(chunkOf(500));
    await turn();

    expect(errors.map((error) => error.message)).toEqual([OVERFLOW]);
  });

  it("frees room as the target takes chunks, so a limit is a ceiling and not a lifetime total", () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 1_000);

    for (let round = 0; round < 50; round += 1) {
      output.stream.write(chunkOf(900));
      stalled.flush();
    }

    expect(output.queuedBytes()).toBe(0);
    expect(stalled.received).toHaveLength(50);
  });

  it("checks before retaining: the refused chunk is never held and never exceeds the limit", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 1_000);
    const peak: number[] = [];

    watched(output);

    for (let index = 0; index < 5; index += 1) {
      output.stream.write(chunkOf(300));
      peak.push(output.queuedBytes());
    }

    await turn();

    expect(Math.max(...peak)).toBeLessThanOrEqual(1_000);
  });

  it("calls onOverflow once, before the wrapper fails", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const order: string[] = [];

    const output = openOutput(stalled.target, input, 100, () => {
      order.push("onOverflow");
    });

    output.stream.once("error", () => order.push("error"));
    output.stream.write(chunkOf(101));
    await turn();
    output.stream.write(chunkOf(101));
    await turn();

    expect(order).toEqual(["onOverflow", "error"]);
  });

  it("reports an overflow once, however many writes follow it before the error is delivered", () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    let reports = 0;

    const output = openOutput(stalled.target, input, 100, () => {
      reports += 1;
    });

    watched(output);

    for (let index = 0; index < 20; index += 1) {
      output.stream.write(chunkOf(101));
    }

    expect(reports).toBe(1);
    expect(output.stream.destroyed).toBe(true);
  });

  it("fails with a static message that carries none of the data", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 10);
    const seen = Promise.withResolvers<Error>();

    output.stream.once("error", (error: Error) => seen.resolve(error));
    output.stream.write(Buffer.from("SECRET-RESPONSE-BODY-0123456789"));

    const error = await seen.promise;

    expect(error.message).toBe(OVERFLOW);
    expect(JSON.stringify(error)).not.toContain("SECRET");
    expect(String(error.stack)).not.toContain("SECRET");
  });

  it("releases everything it held when it fails, and writes nothing more", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 1_000);

    watched(output);
    output.stream.write(chunkOf(400, 1));
    output.stream.write(chunkOf(400, 2));
    output.stream.write(chunkOf(400, 3));
    await turn();

    expect(output.stream.destroyed).toBe(true);
    expect(output.queuedChunks()).toBe(0);
    expect(output.queuedBytes()).toBe(0);

    // The write the target already had completes after the failure: nothing else follows it.
    stalled.flush();
    await turn();

    expect(stalled.received).toEqual([chunkOf(400, 1)]);
    expect(stalled.pendingCount()).toBe(0);
  });

  it("writes nothing more once destroyed, even if the write in flight completes before the stream closes", () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 1_000);

    watched(output);
    output.stream.write(chunkOf(400, 1));
    output.stream.write(chunkOf(400, 2));
    output.stream.write(chunkOf(400, 3));

    // The overflow destroyed the wrapper in this turn; its 'close' has not been delivered yet, and
    // the chunk the target already had completes now: the second chunk must not follow it.
    stalled.flush();

    expect(stalled.pendingCount()).toBe(0);
    expect(stalled.received).toEqual([chunkOf(400, 1)]);
  });

  it("does not let a write that completes after the release disturb the count", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 1_000);

    watched(output);
    output.stream.write(chunkOf(400));
    output.stream.write(chunkOf(400));
    output.stream.write(chunkOf(400));
    await turn();

    expect(output.queuedBytes()).toBe(0);

    stalled.flush();
    await turn();

    expect(output.queuedBytes()).toBe(0);
    expect(output.queuedChunks()).toBe(0);
  });

  it("keeps what came before the overflow whole and in order", async () => {
    const sink = new PassThrough();
    const { input } = flowingInput();
    const output = openOutput(sink, input, 5_000);
    const received: Buffer[] = [];

    watched(output);
    sink.on("data", (chunk: Buffer) => received.push(chunk));

    const sent: Buffer[] = [];

    for (let index = 0; index < 4; index += 1) {
      const chunk = chunkOf(1_000, 97 + index);

      sent.push(chunk);
      output.stream.write(chunk);
      await turn();
    }

    output.stream.write(chunkOf(6_000));
    await turn();

    expect(Buffer.concat(received).equals(Buffer.concat(sent))).toBe(true);
  });

  it("is not silent: the failure reaches a listener, and a missing one is not an uncaught error", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 10);
    const uncaught: Error[] = [];

    const record = (error: Error): void => {
      uncaught.push(error);
    };

    process.on("uncaughtException", record);

    try {
      output.stream.write(chunkOf(11));
      await turn();
      await turn();
    } finally {
      process.off("uncaughtException", record);
    }

    expect(output.stream.destroyed).toBe(true);
    expect(uncaught).toEqual([]);
  });

  it("can still be finished after it failed, without an error or a hang", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 10);

    watched(output);
    output.stream.write(chunkOf(11));
    await turn();

    expect(() => output.finish()).not.toThrow();
  });

  it("holds real memory to the limit: a writer that never stops is refused at the ceiling", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const limit = 16 * KIB * KIB;
    const output = openOutput(stalled.target, input, limit);
    const before = process.memoryUsage().arrayBuffers;
    let peakQueued = 0;
    let writes = 0;

    watched(output);

    // A writer of 1 MiB chunks that does not stop for the pause, as a transport answering requests
    // that were already read does not; it would hold 200 MiB if nothing refused it.
    while (!output.stream.destroyed && writes < 200) {
      output.stream.write(Buffer.alloc(KIB * KIB, 7));
      writes += 1;
      peakQueued = Math.max(peakQueued, output.queuedBytes());
    }

    const retained = process.memoryUsage().arrayBuffers - before;

    expect(output.stream.destroyed).toBe(true);
    expect(writes).toBeLessThan(200);
    expect(peakQueued).toBeLessThanOrEqual(limit);
    // The memory the process really holds: the retained chunks, within a small allowance.
    expect(retained).toBeLessThanOrEqual(limit + 4 * KIB * KIB);
    await turn();
    expect(output.queuedChunks()).toBe(0);
  });
});

describe("createFlowControlledOutput: drained()", () => {
  async function settledWithin(promise: Promise<void>): Promise<"settled" | "pending"> {
    let state: "settled" | "pending" = "pending";

    void promise.then(() => {
      state = "settled";
    });

    for (let index = 0; index < 5; index += 1) {
      await turn();
    }

    return state;
  }

  it("is settled at once when nothing was ever written", async () => {
    const { input } = flowingInput();
    const output = openOutput(new PassThrough(), input);

    expect(await settledWithin(output.drained())).toBe("settled");
  });

  it("waits while a write is held by the target, and settles when the last one completes", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(10));
    output.stream.write(chunkOf(10));
    await turn();

    const drained = output.drained();

    expect(await settledWithin(drained)).toBe("pending");

    stalled.flush(1);

    expect(await settledWithin(drained)).toBe("pending");

    stalled.flush();

    expect(await settledWithin(drained)).toBe("settled");
  });

  it("settles every caller that was waiting, not just the first", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(10));
    await turn();

    const waiting = [output.drained(), output.drained(), output.drained()];

    stalled.flush();

    for (const promise of waiting) {
      expect(await settledWithin(promise)).toBe("settled");
    }
  });

  it("settles when the output is destroyed with bytes still held, since they are gone", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(10));
    await turn();

    const drained = output.drained();

    expect(await settledWithin(drained)).toBe("pending");

    output.stream.destroy();

    expect(await settledWithin(drained)).toBe("settled");
    expect(output.queuedBytes()).toBe(0);
  });

  it("is settled at once for an output that was already destroyed", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input);

    output.stream.write(chunkOf(10));
    await turn();
    output.stream.destroy();
    await turn();

    expect(await settledWithin(output.drained())).toBe("settled");
  });

  it("settles when an overflow destroys it", async () => {
    const stalled = stalledTarget();
    const { input } = flowingInput();
    const output = openOutput(stalled.target, input, 15);

    output.stream.write(chunkOf(10));
    await turn();

    const drained = output.drained();

    output.stream.write(chunkOf(10));
    await turn();

    expect(await settledWithin(drained)).toBe("settled");
  });
});
