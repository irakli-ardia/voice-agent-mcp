import type { Readable, Writable } from "node:stream";
import { type Application, createApplication } from "../bootstrap/create-application.js";
import { serveMcp } from "../bootstrap/serve-mcp.js";
import { type Config, loadConfig } from "../config/config.js";
import { USAGE } from "./cli-arguments.js";
import {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_SOFTWARE,
  EXIT_TERMINATED,
  EXIT_USAGE,
} from "./exit-codes.js";

type StopSignal = "SIGINT" | "SIGTERM";

/** The part of `process` that delivers stop signals; tests pass an `EventEmitter`. */
export interface StopSignalSource {
  once(event: StopSignal, listener: () => void): void;
  off(event: StopSignal, listener: () => void): void;
}

/** Process I/O handed in by the bin, so the server runs in tests on plain streams. */
export interface McpStdioIo {
  /** MCP requests in. */
  readonly stdin: Readable;
  /** MCP responses out: protocol messages only, nothing else is ever written here. */
  readonly stdout: Writable;
  /** Human-readable diagnostics, for failures before the server (and its logger) exists. */
  readonly stderr: (text: string) => void;
  readonly signals: StopSignalSource;
  /** Omitted in production: config then reads the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

const STOP_SIGNALS: readonly StopSignal[] = ["SIGINT", "SIGTERM"];

const SIGNAL_EXIT: Readonly<Record<StopSignal, number>> = {
  SIGINT: EXIT_INTERRUPTED,
  SIGTERM: EXIT_TERMINATED,
};

/**
 * `voice-agent mcp`: serves the canonical tools over MCP on stdio and resolves to the exit code
 * once the connection has ended. It needs no OpenAI key and loads no provider.
 *
 * - stdin EOF: a normal end, exit 0.
 * - SIGINT / SIGTERM: the connection is closed (in-flight calls are aborted) and the code is
 *   130 / 143. Windows delivers neither to a child process, so only EOF ends a server there.
 * - A transport failure such as an oversized message: logged, exit 1, never a quiet 0.
 * - Invalid configuration: reported on stderr without the rejected values, exit 78.
 *
 * It never exits the process itself: once the connection is closed and stdin released, nothing
 * keeps the process alive but work a tool already started, such as a write that is still being
 * committed. Signal listeners are added once and always removed.
 */
export async function runMcpStdio(
  argv: readonly string[],
  io: McpStdioIo,
  create: (config: Config) => Application = createApplication,
): Promise<number> {
  if (argv.length > 0) {
    io.stderr(`error: usage: mcp takes no arguments\n\n${USAGE}`);

    return EXIT_USAGE;
  }

  const config = loadConfig(io.env);

  if (!config.ok) {
    io.stderr(`Invalid configuration:\n  ${config.issues.join("\n  ")}\n`);

    return EXIT_CONFIG;
  }

  const stop = new AbortController();
  let requested: StopSignal | null = null;

  const listeners = STOP_SIGNALS.map((name) => ({
    name,
    listener: (): void => {
      requested ??= name;
      stop.abort();
    },
  }));

  for (const { name, listener } of listeners) {
    io.signals.once(name, listener);
  }

  try {
    const application = create(config.config);

    const outcome = await serveMcp(application, {
      stdin: io.stdin,
      stdout: io.stdout,
      signal: stop.signal,
    });

    if (outcome === "transport_failed") {
      application.logger.error("mcp.stopped", { reason: "transport_failed" });

      return EXIT_FAILURE;
    }

    return requested === null ? EXIT_OK : SIGNAL_EXIT[requested];
  } catch (error) {
    // Only the class is reported: an unexpected error's message may hold paths or secrets.
    io.stderr(
      `error: mcp: unexpected failure (${error instanceof Error ? "Error" : "non-error"})\n`,
    );

    return EXIT_SOFTWARE;
  } finally {
    for (const { name, listener } of listeners) {
      io.signals.off(name, listener);
    }

    // Nothing reads stdin any more. A paused pipe that still holds unread bytes (after an oversized
    // message) would otherwise keep the process alive indefinitely; destroying it releases the
    // handle, and the process ends when its remaining work does.
    io.stdin.destroy();
  }
}
