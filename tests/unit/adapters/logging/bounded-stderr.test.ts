import { describe, expect, it } from "vitest";
import {
  type BoundedStderr,
  type ChunkSink,
  createBoundedStderr,
  STDERR_ERROR_RESERVE_BYTES,
  STDERR_QUEUE_BYTES,
  windowsWriterSink,
} from "../../../../src/adapters/logging/bounded-stderr.js";

/** A stderr the test controls: each write waits until the test finishes it. */
function heldStderr(options: { maxQueuedBytes?: number; errorReserveBytes?: number } = {}) {
  const written: string[] = [];
  const pending: { chunk: Buffer; done: (error?: Error | null) => void }[] = [];

  const sink: ChunkSink = {
    write: (chunk, done) => {
      pending.push({ chunk, done });
    },
  };

  const stderr: BoundedStderr = createBoundedStderr({ sink, ...options });

  return {
    sink: stderr,
    written,
    outstanding: () => pending.length,
    /** Completes the oldest write, or fails it. */
    finish: (outcome: "all" | Error = "all"): void => {
      const next = pending.shift();

      if (next === undefined) {
        throw new Error("No write is outstanding.");
      }

      if (outcome instanceof Error) {
        next.done(outcome);
      } else {
        written.push(next.chunk.toString());
        next.done(null);
      }
    },
  };
}

const line = (level: number, text: string): string => `{"level":${level},"msg":"${text}"}\n`;

describe("createBoundedStderr", () => {
  it("writes a line at once and lines in order, one write at a time", () => {
    const held = heldStderr();

    held.sink.write(line(30, "a"));
    held.sink.write(line(30, "b"));
    expect(held.outstanding()).toBe(1);

    held.finish();
    held.finish();

    expect(held.written).toEqual([line(30, "a"), line(30, "b")]);
    expect(held.sink.queuedBytes()).toBe(0);
  });

  it("holds no more than its limit while stderr is stalled, and drops the newest whole lines", () => {
    const held = heldStderr({ maxQueuedBytes: 100, errorReserveBytes: 0 });
    const each = line(30, "x".repeat(20));

    for (let count = 0; count < 1_000; count += 1) {
      held.sink.write(each);
    }

    expect(held.sink.queuedBytes()).toBeLessThanOrEqual(100);
    expect(held.sink.queuedBytes() % each.length).toBe(0);
    expect(held.sink.droppedLines()).toBe(1_000 - Math.floor(100 / each.length));
    expect(held.outstanding()).toBe(1);
  });

  it("lets error lines use a reserve that routine lines cannot", () => {
    const held = heldStderr({ maxQueuedBytes: 60, errorReserveBytes: 120 });
    const routine = line(30, "r".repeat(20));
    const failure = line(50, "e".repeat(20));

    for (let count = 0; count < 10; count += 1) {
      held.sink.write(routine);
    }

    held.sink.write(failure);
    held.sink.write(failure);

    expect(held.sink.queuedBytes()).toBeGreaterThan(60);
    expect(held.sink.queuedBytes()).toBeLessThanOrEqual(180);

    while (held.outstanding() > 0) {
      held.finish();
    }

    expect(held.written.filter((text) => text === failure)).toHaveLength(2);
  });

  it("says what it dropped, once, when the queue next empties", () => {
    const held = heldStderr({ maxQueuedBytes: 40, errorReserveBytes: 0 });
    const text = line(30, "x".repeat(10));

    for (let count = 0; count < 5; count += 1) {
      held.sink.write(text);
    }

    const dropped = held.sink.droppedLines();

    expect(dropped).toBeGreaterThan(0);

    while (held.outstanding() > 0) {
      held.finish();
    }

    const summaries = held.written.filter((entry) => entry.includes('"log.dropped"'));

    expect(summaries).toHaveLength(1);
    expect(JSON.parse(summaries[0] ?? "")).toMatchObject({
      level: 40,
      msg: "log.dropped",
      droppedLines: dropped,
      droppedBytes: dropped * text.length,
    });
    expect(held.sink.droppedLines()).toBe(0);
    expect(held.sink.queuedBytes()).toBe(0);
  });

  it("discards a line whose write failed and goes on with the next", () => {
    const held = heldStderr();

    held.sink.write(line(30, "lost"));
    held.sink.write(line(30, "kept"));
    held.finish(new Error("EPIPE"));
    held.finish();

    expect(held.written).toEqual([line(30, "kept")]);
    expect(held.sink.queuedBytes()).toBe(0);
  });

  it("takes a line that fits the queue exactly, and drops the next byte", () => {
    const text = line(30, "x".repeat(10));
    const held = heldStderr({ maxQueuedBytes: text.length * 2, errorReserveBytes: 0 });

    held.sink.write(text);
    held.sink.write(text);
    expect(held.sink.droppedLines()).toBe(0);
    expect(held.sink.queuedBytes()).toBe(text.length * 2);

    held.sink.write("x");
    expect(held.sink.droppedLines()).toBe(1);
  });

  it("drops a line larger than the whole queue instead of writing part of it", () => {
    const held = heldStderr({ maxQueuedBytes: 10, errorReserveBytes: 0 });

    held.sink.write(line(30, "this line is far too long for the queue"));

    expect(held.outstanding()).toBe(0);
    expect(held.sink.droppedLines()).toBe(1);
  });

  it("treats a line it cannot classify as an error, so it is never the one dropped first", () => {
    const held = heldStderr({ maxQueuedBytes: 10, errorReserveBytes: 100 });

    held.sink.write("not json at all\n");

    expect(held.outstanding()).toBe(1);
    expect(held.sink.droppedLines()).toBe(0);
  });

  it("defaults to a queue of 64 KiB and an error reserve of 64 KiB", () => {
    expect(STDERR_QUEUE_BYTES).toBe(65_536);
    expect(STDERR_ERROR_RESERVE_BYTES).toBe(65_536);
  });
});

describe("createBoundedStderr flush", () => {
  it("resolves at once when nothing is queued", async () => {
    const held = heldStderr();

    await expect(held.sink.flush(1_000)).resolves.toBeUndefined();
  });

  it("waits for the queue to empty, then lets the sink finish", async () => {
    const written: string[] = [];
    const closed: number[] = [];
    const pending: ((error?: Error | null) => void)[] = [];

    const sink: ChunkSink = {
      write: (chunk, done) => {
        written.push(chunk.toString());
        pending.push(done);
      },
      close: async (timeoutMs) => {
        closed.push(timeoutMs);
      },
    };

    const stderr = createBoundedStderr({ sink });

    stderr.write(line(30, "a"));

    const flushed = stderr.flush(1_000);

    pending.shift()?.(null);
    await flushed;

    expect(written).toEqual([line(30, "a")]);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeLessThanOrEqual(1_000);
    expect(closed[0]).toBeGreaterThan(0);
  });

  it("gives up at the timeout when the sink never finishes, and still closes the sink", async () => {
    const closed: number[] = [];

    const sink: ChunkSink = {
      write: () => undefined,
      close: async (timeoutMs) => {
        closed.push(timeoutMs);
      },
    };

    const stderr = createBoundedStderr({ sink });

    stderr.write(line(30, "stuck"));

    await stderr.flush(30);

    // Nothing is left of the time (a timer may fire a millisecond early).
    expect(closed).toHaveLength(1);
    expect(closed[0]).toBeLessThanOrEqual(5);
    expect(stderr.queuedBytes()).toBeGreaterThan(0);
  });
});

describe("windowsWriterSink (the Windows sink, which works anywhere a helper can be started)", () => {
  it("hands a chunk to a helper process, and ends the helper on close", async () => {
    const sink = windowsWriterSink();

    // The helper copies this line to the stderr of the test run: a labelled, harmless JSON line.
    const written = await new Promise<Error | null | undefined>((resolve) => {
      sink.write(Buffer.from('{"level":30,"msg":"bounded-stderr test: helper sink"}\n'), resolve);
    });

    expect(written ?? null).toBeNull();
    await sink.close?.(5_000);

    const afterClose = await new Promise<Error | null | undefined>((resolve) => {
      sink.write(Buffer.from("late\n"), resolve);
    });

    expect(afterClose).toBeInstanceOf(Error);
  });

  it("closes at once when nothing was ever written", async () => {
    await expect(windowsWriterSink().close?.(1_000)).resolves.toBeUndefined();
  });
});

describe("createBoundedStderr on this platform", () => {
  it("writes through the real sink and flushes", async () => {
    const stderr = createBoundedStderr();

    stderr.write('{"level":30,"msg":"bounded-stderr test: default sink"}\n');
    await stderr.flush(5_000);

    expect(stderr.droppedLines()).toBe(0);
  });
});
