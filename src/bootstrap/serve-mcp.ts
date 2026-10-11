import type { Readable, Writable } from "node:stream";
import { StdioServerTransport, serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "../adapters/mcp/create-mcp-server.js";
import { systemIdGenerator } from "../adapters/system/system-id-generator.js";
import type { Application } from "./create-application.js";

/** Largest inbound message the stdio transport buffers: far above any real request, far below memory trouble. */
export const MCP_MAX_MESSAGE_BYTES = 1_048_576;

/** Reported to clients; a test keeps it equal to the package version. */
export const MCP_SERVER_NAME = "voice-agent-mcp";

export const MCP_SERVER_VERSION = "0.1.0";

export interface ServeMcpOptions {
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** Aborts to ask for a graceful stop: the connection is closed and in-flight calls are aborted. */
  readonly signal: AbortSignal;
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

  const transport = new StdioServerTransport(options.stdin, options.stdout, {
    maxBufferSize: MCP_MAX_MESSAGE_BYTES,
  });

  const ended = Promise.withResolvers<McpServeOutcome>();
  let reportedThisStep = false;

  const connection = serveStdio(
    () =>
      createMcpServer({
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        tools,
        executeTool,
        ids: systemIdGenerator,
        maxInFlightCalls: config.mcp.maxInFlightCalls,
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
    sdkOnClose?.();
    ended.resolve(reportedThisStep ? "transport_failed" : "closed");
  };

  const stop = (): void => {
    void connection.close();
  };

  options.signal.addEventListener("abort", stop, { once: true });

  if (options.signal.aborted) {
    stop();
  }

  try {
    return await ended.promise;
  } finally {
    options.signal.removeEventListener("abort", stop);
  }
}
