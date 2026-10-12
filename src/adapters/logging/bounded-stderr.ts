import { type ChildProcess, spawn } from "node:child_process";
import type { Writable } from "node:stream";
import type { DestinationStream } from "pino";

/** Bytes of log lines that may wait for stderr; a line that would pass it is dropped and counted. */
export const STDERR_QUEUE_BYTES = 65_536;

/**
 * Extra bytes only error-level lines may use, so a flood of routine lines that fills the queue
 * cannot also push out the one line that says why the server is failing.
 */
export const STDERR_ERROR_RESERVE_BYTES = 65_536;

/** pino's numeric level of `error`. */
const ERROR_LEVEL = 50;

const LEVEL_PREFIX = /^\{"level":(\d+)/;

/** Where queued lines finally go. The callback runs once the chunk is written or has failed. */
export interface ChunkSink {
  write(chunk: Buffer, callback: (error?: Error | null) => void): void;
  /** Lets whatever the sink owns finish for at most `timeoutMs`, then releases it. Never rejects. */
  close?(timeoutMs: number): Promise<void>;
}

export interface BoundedStderrOptions {
  readonly maxQueuedBytes?: number;
  readonly errorReserveBytes?: number;
  /** Replaced only in tests. */
  readonly sink?: ChunkSink;
}

export interface BoundedStderr extends DestinationStream {
  /** Bytes waiting or being written right now; never more than the queue limit plus the reserve. */
  queuedBytes(): number;
  /** Lines dropped since the last `log.dropped` line was queued. */
  droppedLines(): number;
  /**
   * Waits at most `timeoutMs` for the queue to empty and the sink to finish, for an orderly end.
   * Whatever is still unwritten then is lost, as it is when the process ends first. Never rejects.
   */
  flush(timeoutMs: number): Promise<void>;
}

/** What the writer process does: copy its input to its own stderr, which is the host's. */
const WRITER_SOURCE =
  "process.on('SIGINT', () => {}); process.stdin.on('data', (chunk) => process.stderr.write(chunk));";

export interface WindowsWriterOptions {
  /** Starts the writer process; replaced only in tests. */
  readonly spawnHelper?: () => ChildProcess;
  /** Registers what runs when this process exits; replaced only in tests. */
  readonly onProcessExit?: (listener: () => void) => void;
}

/** A node process with nothing but a pipe in, the host's stderr out, and an empty environment. */
export function startHelperProcess(): ChildProcess {
  return spawn(process.execPath, ["-e", WRITER_SOURCE], {
    stdio: ["pipe", "ignore", 2],
    windowsHide: true,
    env: {},
  });
}

function onThisProcessExit(listener: () => void): void {
  process.once("exit", listener);
}

/**
 * Windows. A write to an inherited pipe whose reader has stopped blocks the calling thread for
 * good: `process.stderr` would stop the event loop, and a write on a thread-pool thread would stop
 * the process from ever exiting (both measured). So the blocking write is done by a small helper
 * process that this one feeds through a pipe of its own, which Node writes without blocking. The
 * helper is started at the first line and killed when this process exits, so a stalled reader
 * costs a parked helper and nothing here.
 */
export function windowsWriterSink(options: WindowsWriterOptions = {}): ChunkSink {
  const spawnHelper = options.spawnHelper ?? startHelperProcess;
  const onProcessExit = options.onProcessExit ?? onThisProcessExit;
  let helper: ChildProcess | undefined;
  let input: Writable | undefined;
  let begun = false;
  let broken = false;
  let handingOver = 0;

  const start = (): ChildProcess | undefined => {
    try {
      const started = spawnHelper();

      started.on("error", () => {
        broken = true;
      });
      started.on("exit", () => {
        broken = true;
      });
      started.stdin?.on("error", () => {
        broken = true;
      });
      input = started.stdin ?? undefined;
      started.unref();
      // At the end of this process: a helper that has been handed everything may finish writing it
      // (it ends when its input does); one that is still being fed is stuck behind a stalled reader.
      onProcessExit(() => {
        if (handingOver === 0) {
          started.stdin?.end();
        } else {
          started.kill();
        }
      });

      return started;
    } catch {
      broken = true;

      return undefined;
    }
  };

  return {
    write: (chunk, callback): void => {
      if (!begun) {
        begun = true;
        helper = start();
      }

      const target = broken ? undefined : input;

      if (target === undefined) {
        callback(new Error("The log writer is not running."));

        return;
      }

      handingOver += 1;
      target.write(chunk, (error) => {
        handingOver -= 1;
        callback(error);
      });
    },
    close: async (timeoutMs): Promise<void> => {
      const closing = helper;

      if (closing === undefined || closing.exitCode !== null) {
        return;
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);

        closing.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        closing.stdin?.end();
      });
      closing.kill();
    },
  };
}

/** POSIX: `process.stderr` on a pipe is asynchronous, so a stalled reader never blocks the loop. */
function processSink(): ChunkSink {
  return process.platform === "win32" ? windowsWriterSink() : process.stderr;
}

/** The one line that says logs were lost: counts only. */
function droppedSummary(lines: number, bytes: number): Buffer {
  const summary = { level: 40, time: Date.now(), msg: "log.dropped" };

  return Buffer.from(`${JSON.stringify({ ...summary, droppedLines: lines, droppedBytes: bytes })}
`);
}

function levelOf(line: string): number {
  const level = LEVEL_PREFIX.exec(line)?.[1];

  return level === undefined ? ERROR_LEVEL : Number(level);
}

/**
 * Where the MCP server's logs go: stderr, without ever waiting for it.
 *
 * Writing to a pipe whose reader has stopped blocks forever on Windows, and a blocked synchronous
 * write stops the whole process (measured: the server stopped answering after about 310 calls).
 * Here a line is queued in memory and handed to the sink one at a time, so at most one write is
 * ever outstanding. No timer and no promise: a write's callback starts the next.
 *
 * **Overflow policy (deterministic, drop-newest):** the queue holds at most `maxQueuedBytes`; error
 * lines may use `errorReserveBytes` more. A line that does not fit is dropped whole, counted, and
 * never written partly. When the queue next empties, one `log.dropped` line with the counts is
 * queued, so the loss itself is visible once stderr is read again. A write that fails (the reader
 * closed the pipe) discards that line and goes on.
 *
 * **Not a durable log:** lines wait in memory. A process that ends, or is ended by the forced-exit
 * backstop, before they are written loses them, and lines are lost when stderr stalls. Only
 * counts and fixed events go through the logger, so what is lost is diagnostics, never data.
 */
export function createBoundedStderr(options: BoundedStderrOptions = {}): BoundedStderr {
  const maxQueuedBytes = options.maxQueuedBytes ?? STDERR_QUEUE_BYTES;
  const errorReserveBytes = options.errorReserveBytes ?? STDERR_ERROR_RESERVE_BYTES;
  const sink = options.sink ?? processSink();
  const queue: Buffer[] = [];
  let queued = 0;
  let writing = false;
  const idleWaiters: (() => void)[] = [];
  let dropped = 0;
  let droppedBytes = 0;

  const enqueue = (chunk: Buffer): void => {
    queue.push(chunk);
    queued += chunk.byteLength;
  };

  const pump = (): void => {
    if (writing) {
      return;
    }

    if (queue.length === 0 && dropped > 0) {
      enqueue(droppedSummary(dropped, droppedBytes));
      dropped = 0;
      droppedBytes = 0;
    }

    const head = queue[0];

    if (head === undefined) {
      for (const waiter of idleWaiters.splice(0)) {
        waiter();
      }

      return;
    }

    writing = true;
    sink.write(head, () => {
      writing = false;
      queue.shift();
      queued -= head.byteLength;
      pump();
    });
  };

  return {
    write: (line: string): void => {
      const chunk = Buffer.from(line);

      const limit =
        levelOf(line) >= ERROR_LEVEL ? maxQueuedBytes + errorReserveBytes : maxQueuedBytes;

      if (queued + chunk.byteLength > limit) {
        dropped += 1;
        droppedBytes += chunk.byteLength;

        return;
      }

      enqueue(chunk);
      pump();
    },
    queuedBytes: (): number => queued,
    droppedLines: (): number => dropped,
    flush: async (timeoutMs: number): Promise<void> => {
      const startedAt = Date.now();

      if (queue.length > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);

          idleWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }

      await sink.close?.(Math.max(0, timeoutMs - (Date.now() - startedAt)));
    },
  };
}
