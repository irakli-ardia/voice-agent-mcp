import type { Readable, Writable } from "node:stream";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { type CallAdmission, createCallAdmission } from "../adapters/mcp/call-admission.js";
import { createMcpServer } from "../adapters/mcp/create-mcp-server.js";
import { systemClock } from "../adapters/system/system-clock.js";
import { systemIdGenerator } from "../adapters/system/system-id-generator.js";
import type { Config } from "../config/config.js";
import type { Application } from "./create-application.js";
import { createFlowControlledOutput, type FlowControlledOutput } from "./flow-controlled-output.js";

/** Largest inbound message the stdio transport buffers: far above any real request, far below memory trouble. */
export const MCP_MAX_MESSAGE_BYTES = 1_048_576;

/** Reported to clients; a test keeps it equal to the package version. */
export const MCP_SERVER_NAME = "voice-agent-mcp";

export const MCP_SERVER_VERSION = "0.1.0";

/**
 * What the output queue may hold beyond the answers to calls already running: the pause threshold
 * plus the answers to the one read of input that crossed it (measured 6.7 MB for the smallest
 * requests, which are answered about a hundred times larger), with a wide margin for a longer tool
 * list.
 */
export const OUTPUT_QUEUE_BASE_BYTES = 33_554_432;

/**
 * One answer is at most `3 x maxResultBytes + 4 KiB`: the result appears as `structuredContent` and
 * again as JSON text, and the text escapes each quote and backslash, so it is at most twice the
 * result's size.
 */
const ANSWER_ENVELOPE_BYTES = 4_096;

/**
 * The most the output queue may retain: the base above plus, for every call that can still be
 * running when the input is paused, its largest possible answer. With the defaults (16 calls, 16 KiB
 * results) that is about 33 MiB; with the largest settings (128 calls, 1 MiB results) about 416 MiB,
 * which is what those settings allow, not more.
 */
export function outputQueueLimit(
  config: Pick<Config, "maxToolResultBytes"> & {
    readonly mcp: Pick<Config["mcp"], "maxInFlightCalls">;
  },
): number {
  const answer = 3 * config.maxToolResultBytes + ANSWER_ENVELOPE_BYTES;

  return OUTPUT_QUEUE_BASE_BYTES + config.mcp.maxInFlightCalls * answer;
}

/**
 * How long a shutdown waits for running handlers to settle and for answers already queued to be
 * written, counted from the first sign of the end (a stop request, or the connection closing).
 * Handlers that respect their signal settle in milliseconds, so this only decides how long one that
 * ignores it, or a client that stopped reading, can delay the end. A constant, not configuration.
 */
export const MCP_SHUTDOWN_GRACE_MS = 2_000;

interface Deadline {
  readonly passed: Promise<"deadline">;
  start(): void;
  clear(): void;
}

/** One timer, started by the first sign of the end; later starts change nothing. */
function createDeadline(ms: number): Deadline {
  const passed = Promise.withResolvers<"deadline">();
  let timer: NodeJS.Timeout | undefined;

  return {
    passed: passed.promise,
    start: (): void => {
      timer ??= setTimeout(() => {
        passed.resolve("deadline");
      }, ms);
    },
    clear: (): void => {
      clearTimeout(timer);
    },
  };
}

/**
 * Waits until every running handler has settled and every answer already queued has been written,
 * or until the deadline. At the deadline it says what is being given up, as counts only: nothing
 * undelivered is silently dropped, and nothing about it is described.
 */
async function settleShutdown(
  application: Application,
  output: FlowControlledOutput,
  deadline: { readonly passed: Promise<"deadline"> },
  graceMs: number,
): Promise<void> {
  const settled = await Promise.race([
    Promise.all([application.handlerLedger.idle(), output.drained()]).then(() => "settled"),
    deadline.passed,
  ]);

  if (settled === "settled") {
    return;
  }

  const { unsettled, abandoned } = application.handlerLedger.counts();

  application.logger.warn("mcp.shutdown_incomplete", {
    graceMs,
    unsettledHandlers: unsettled,
    abandonedHandlers: abandoned,
    undeliveredBytes: output.queuedBytes(),
    undeliveredChunks: output.queuedChunks(),
  });
}

export interface ServeMcpOptions {
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** Aborts to ask for a graceful stop: the connection is closed and in-flight calls are aborted. */
  readonly signal: AbortSignal;
  /** Replaces the derived output queue limit; only tests, which cannot produce 33 MiB of answers. */
  readonly maxOutputQueueBytes?: number;
  /** Replaces the admission policy built from the configuration; only tests, to watch it close. */
  readonly admission?: CallAdmission;
  /** Replaces `MCP_SHUTDOWN_GRACE_MS`; only tests, which cannot wait seconds. */
  readonly shutdownGraceMs?: number;
}

/**
 * How the connection ended. `transport_failed` means the transport reported an error and closed
 * itself in the same step (an oversized message, a failed write): a failure, never a success.
 * `closed` is every other end: the client closed stdin, or a stop was requested.
 */
export type McpServeOutcome = "closed" | "transport_failed";

/**
 * Serves the application's canonical tools over MCP on the given streams until the connection
 * ends. Both protocol eras are served by the SDK's `serveStdio`; this function only composes. The
 * SDK may call the factory more than once per connection (it discards a probe instance), so the
 * factory builds only a `Server` over the one shared application: no second registry, executor,
 * logger, or store, and no listeners of its own.
 *
 * Transport errors are logged as a fixed event, never with the SDK's error or its message. It
 * performs no process-wide side effects: the caller owns signals, exit codes, and the streams.
 */
export async function serveMcp(
  application: Application,
  options: ServeMcpOptions,
): Promise<McpServeOutcome> {
  const { config, logger, tools, executeTool } = application;

  // Answers are written through a wrapper that stops reading requests while stdout is backed up,
  // and fails the connection, rather than grow without limit, if it ever holds more than the limit.
  const maxQueuedBytes = options.maxOutputQueueBytes ?? outputQueueLimit(config);

  const output = createFlowControlledOutput(options.stdout, options.stdin, {
    maxQueuedBytes,
    onOverflow: (): void => {
      logger.error("mcp.output_queue_overflow", { limitBytes: maxQueuedBytes });
    },
  });

  const transport = new StdioServerTransport(options.stdin, output.stream, {
    maxBufferSize: MCP_MAX_MESSAGE_BYTES,
  });

  // One admission policy for the process: the SDK may build several `Server`s per connection.
  const admission =
    options.admission ??
    createCallAdmission({
      clock: systemClock,
      logger,
      maxCallsPerSecond: config.mcp.maxCallsPerSecond,
      maxInFlightCalls: config.mcp.maxInFlightCalls,
    });

  const ended = Promise.withResolvers<McpServeOutcome>();
  const graceMs = options.shutdownGraceMs ?? MCP_SHUTDOWN_GRACE_MS;
  const deadline = createDeadline(graceMs);
  let reportedThisStep = false;

  // The first sign of the end closes admission, so no handler starts from here on, and starts the
  // one deadline the rest of the shutdown is measured against. Later signs change nothing.
  const beginShutdown = (): void => {
    admission.close();
    deadline.start();
  };

  const connection = serveStdio(
    () =>
      createMcpServer({
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        tools,
        executeTool,
        ids: systemIdGenerator,
        admission,
      }),
    {
      transport,
      // The error itself is not read: the SDK's message can echo what a client sent.
      onerror: (): void => {
        logger.warn("mcp.transport_error");
        reportedThisStep = true;
        queueMicrotask(() => {
          reportedThisStep = false;
        });
      },
    },
  );

  // `serveStdio` owns `onclose` and offers no hook for the end of the connection, so this wraps it.
  const sdkOnClose = transport.onclose;

  transport.onclose = (): void => {
    beginShutdown();
    sdkOnClose?.();
    ended.resolve(reportedThisStep ? "transport_failed" : "closed");
  };

  const stop = (): void => {
    beginShutdown();
    void connection.close();
  };

  options.signal.addEventListener("abort", stop, { once: true });

  if (options.signal.aborted) {
    stop();
  }

  try {
    const outcome = await ended.promise;

    // The connection is closed: no request is read, no answer can be sent, and the running calls
    // were aborted. What remains is to let them settle, and the answers already queued reach the
    // client, but only until the deadline.
    await settleShutdown(application, output, deadline, graceMs);

    return outcome;
  } finally {
    deadline.clear();
    options.signal.removeEventListener("abort", stop);
    output.finish();
  }
}
