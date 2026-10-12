import { type Readable, Writable } from "node:stream";

/**
 * Queued bytes at which the input is paused. A pause threshold, not a limit: the answers to the
 * read of input that crossed it, and to calls already running, are still queued after it.
 */
export const OUTPUT_HIGH_WATER_MARK = 65_536;

/** The only message an overflow carries: static, never a byte of what was queued. */
const OVERFLOW_MESSAGE = "The output queue limit was exceeded.";

export interface FlowControlOptions {
  /**
   * The most bytes the wrapper may retain, counting every chunk not yet written to the target and
   * the one being written. A write that would pass it is refused and the wrapper fails.
   */
  readonly maxQueuedBytes: number;
  /** Called once, before the wrapper fails, so the owner can log the overflow. */
  readonly onOverflow: () => void;
}

export interface FlowControlledOutput {
  /** What the transport writes to: it applies backpressure to `input`, then forwards to `target`. */
  readonly stream: Writable;
  /** Ends the wrapper once the connection is over: queued output is still flushed, then it stops. */
  finish(): void;
  /**
   * Resolves when nothing is queued or being written, or when the wrapper has been destroyed (what
   * it held is then gone). Never rejects; a target that never accepts a write never resolves it.
   */
  drained(): Promise<void>;
  /** Bytes retained right now: queued chunks plus the one being written to the target. */
  queuedBytes(): number;
  /** Chunks retained right now; 0 once the wrapper has been destroyed. */
  queuedChunks(): number;
}

interface DrainGate {
  drained(): Promise<void>;
  release(): void;
}

/** `drained()` for a writer: resolves at once when `idle()`, otherwise when `release()` is called. */
function createDrainGate(idle: () => boolean): DrainGate {
  const waiting: (() => void)[] = [];

  return {
    drained: async (): Promise<void> => {
      if (!idle()) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      }
    },
    release: (): void => {
      for (const resolve of waiting.splice(0)) {
        resolve();
      }
    },
  };
}

/**
 * A writable between the MCP transport and the real output that stops reading input while the
 * output is backed up.
 *
 * The SDK's stdio transport reads and answers requests as fast as they arrive, so a client that
 * sends requests but does not read the answers makes the server queue every response in memory
 * (measured on Linux: about 90 MB per 10 000 unread `tools/list` answers, without limit; Windows
 * pipes block the process instead). Here every chunk is queued in this module and handed to
 * `target` one at a time, in order and whole, so each JSON-RPC line is written intact. While the
 * bytes not yet written to `target` reach `OUTPUT_HIGH_WATER_MARK` the input is paused, and it
 * resumes when they fall below it again.
 *
 * The pause threshold is not the size of the queue. After the pause, the answers to the one read of
 * input that crossed it (the stream's read size, typically 64 KiB of requests) and to calls already
 * running are still queued: measured at 6.7 MB for the smallest `tools/list` requests, which are
 * answered about a hundred times larger. What is enforced is `maxQueuedBytes`: a write that would
 * pass it is not retained, and the wrapper fails with a static error, which the transport reports as
 * a failed connection, so no response is ever dropped silently. When the wrapper is destroyed, what
 * it still held is released. While paused, an end of input is not seen until the output drains; a
 * stop request closes the connection regardless.
 */
export function createFlowControlledOutput(
  target: Writable,
  input: Readable,
  options: FlowControlOptions,
): FlowControlledOutput {
  const queue: Buffer[] = [];
  let queuedBytes = 0;
  let writing = false;
  let finished = false;
  let inputPaused = false;
  const drainGate = createDrainGate(() => output.destroyed || (queue.length === 0 && !writing));

  const pumpNext = (): void => {
    if (writing) {
      return;
    }

    const next = queue.shift();

    if (next === undefined) {
      drainGate.release();

      return;
    }

    writing = true;
    // A failed write also emits 'error' on `target`, which is forwarded below, so the callback
    // does not look at it.
    target.write(next, () => {
      writing = false;

      // Destroyed meanwhile: the queue was released with it, and nothing more is written.
      if (output.destroyed) {
        return;
      }

      queuedBytes -= next.byteLength;

      // Only the connection pauses the input and only it resumes it, and not after it has finished.
      if (inputPaused && queuedBytes < OUTPUT_HIGH_WATER_MARK) {
        inputPaused = false;

        if (!finished) {
          input.resume();
        }
      }

      pumpNext();
    });
  };

  const output = new Writable({
    // Chunks are accepted at once: the bound is on the bytes still queued, enforced by pausing the
    // input, not by refusing writes the transport has already decided to make.
    write: (chunk: Buffer, _encoding, callback): void => {
      // Checked before the chunk is retained, so the queue never holds more than the limit.
      if (queuedBytes + chunk.byteLength > options.maxQueuedBytes) {
        // Destroyed here, not by the callback's error, so that writes made before the error is
        // delivered are refused too and this runs, and is reported, exactly once.
        options.onOverflow();
        output.destroy(new Error(OVERFLOW_MESSAGE));
        callback();

        return;
      }

      queue.push(chunk);
      queuedBytes += chunk.byteLength;

      // After `finish` the wrapper is ended, so no write reaches this point to be counted.
      if (!inputPaused && queuedBytes >= OUTPUT_HIGH_WATER_MARK) {
        inputPaused = true;
        input.pause();
      }

      pumpNext();
      callback();
    },
    // Ending waits for what is queued to be written (or for the wrapper to be destroyed).
    final: (callback): void => {
      void drainGate.drained().then(() => callback());
    },
  });

  // The transport owns error handling and stays subscribed; this only stops a late error from
  // becoming an uncaught exception once it has detached.
  output.on("error", () => {});

  // However it ends, nothing stays referenced: an error, an overflow, or a finished stream.
  output.on("close", () => {
    queue.length = 0;
    queuedBytes = 0;
    drainGate.release();
  });

  const forwardTargetError = (error: Error): void => void output.destroy(error);

  target.on("error", forwardTargetError);

  return {
    stream: output,
    finish: (): void => {
      finished = true;
      target.off("error", forwardTargetError);
      output.end();
    },
    drained: drainGate.drained,
    queuedBytes: (): number => queuedBytes,
    queuedChunks: (): number => queue.length,
  };
}
