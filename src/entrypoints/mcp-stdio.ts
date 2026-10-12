import type { Readable, Writable } from "node:stream";
import { type Application, createApplication } from "../bootstrap/create-application.js";
import { MCP_SHUTDOWN_GRACE_MS, serveMcp } from "../bootstrap/serve-mcp.js";
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
import type { StopSignalSource } from "./interrupt.js";

type StopSignal = "SIGINT" | "SIGTERM";

/**
 * Time after the shutdown grace (`MCP_SHUTDOWN_GRACE_MS`) that the process is given to end by
 * itself before it is ended for it: the grace bounds what the server waits for, this bounds
 * everything else that can keep the process alive.
 */
export const MCP_FORCE_EXIT_SLACK_MS = 500;

/**
 * The longest an orderly end waits for queued log lines to reach stderr. It is well inside
 * `MCP_FORCE_EXIT_SLACK_MS`, and a stalled stderr costs exactly this and then loses the lines.
 */
export const MCP_LOG_FLUSH_MS = 250;

/** Process I/O handed in by the bin, so the server runs in tests on plain streams. */
export interface McpStdioIo {
  /** MCP requests in. */
  readonly stdin: Readable;
  /** MCP responses out: protocol messages only, nothing else is ever written here. */
  readonly stdout: Writable;
  /** Human-readable diagnostics, for failures before the server (and its logger) exists. */
  readonly stderr: (text: string) => void;
  readonly signals: StopSignalSource;
  /**
   * Ends the process now, with this exit code. Called at most once, and only if the process is still
   * alive `MCP_SHUTDOWN_GRACE_MS + MCP_FORCE_EXIT_SLACK_MS` after a shutdown began, because a tool
   * handler, a blocked filesystem call, or a client that stopped reading keeps it alive. Whatever
   * those were doing is interrupted, and answers still queued are not delivered. Omitted in tests;
   * the bin passes `process.exit`, the only place that may call it.
   */
  readonly forceExit?: (code: number) => void;
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
 *   130 / 143. Windows delivers neither to a child process, so only EOF ends a server there. A
 *   repeated signal changes nothing: shutdown runs once, and the first signal's code stands.
 * - A transport failure such as an oversized message: logged, exit 1, never a quiet 0.
 * - Invalid configuration: reported on stderr without the rejected values, exit 78.
 *
 * It never exits the process itself. Once the connection is closed and stdin released, nothing keeps
 * the process alive but work a tool already started (a write still committing, a call blocked in
 * I/O) or answers a client will not read. The server waits for those for `MCP_SHUTDOWN_GRACE_MS`;
 * if the process is still alive shortly after, `io.forceExit` is called, once, with the exit code.
 * Signal listeners are added once and always removed.
 */
export async function runMcpStdio(
  argv: readonly string[],
  io: McpStdioIo,
  create: (config: Config) => Application = (loaded) =>
    createApplication(loaded, { stderr: "non-blocking" }),
  serve: typeof serveMcp = serveMcp,
): Promise<number> {
  if (argv.length > 0) {
    io.stderr(`error: usage: mcp takes no arguments\n\n${USAGE}`);

    return EXIT_USAGE;
  }

  // `DATA_DIR` must be explicit and absolute: the host chooses the working directory, not the user.
  const config = loadConfig(io.env, { dataDir: "explicit-absolute" });

  if (!config.ok) {
    io.stderr(`Invalid configuration:\n  ${config.issues.join("\n  ")}\n`);

    return EXIT_CONFIG;
  }

  const stop = new AbortController();
  let requested: StopSignal | null = null;
  let application: Application | undefined;
  let exitCode: number | undefined;
  let forceTimer: NodeJS.Timeout | undefined;

  // Armed once, by the first sign of the end, and only when the bin gave a way to end the process.
  // Unreferenced: a process that ends by itself is not held for it.
  const armForceExit = (delayMs: number): void => {
    const { forceExit } = io;

    if (forceExit === undefined || forceTimer !== undefined) {
      return;
    }

    forceTimer = setTimeout(() => {
      const code = exitCode ?? (requested === null ? EXIT_FAILURE : SIGNAL_EXIT[requested]);

      application?.logger.error("mcp.shutdown_forced", { exitCode: code });
      forceExit(code);
    }, delayMs);
    forceTimer.unref();
  };

  const listeners = STOP_SIGNALS.map((name) => ({
    name,
    listener: (): void => {
      requested ??= name;
      armForceExit(MCP_SHUTDOWN_GRACE_MS + MCP_FORCE_EXIT_SLACK_MS);
      stop.abort();
    },
  }));

  for (const { name, listener } of listeners) {
    io.signals.on(name, listener);
  }

  try {
    application = create(config.config);

    const outcome = await serve(application, {
      stdin: io.stdin,
      stdout: io.stdout,
      signal: stop.signal,
    });

    if (outcome === "transport_failed") {
      application.logger.error("mcp.stopped", { reason: "transport_failed" });
      exitCode = EXIT_FAILURE;
    } else {
      exitCode = requested === null ? EXIT_OK : SIGNAL_EXIT[requested];
    }

    return exitCode;
  } catch (error) {
    // Only the class is reported: an unexpected error's message may hold paths or secrets.
    io.stderr(
      `error: mcp: unexpected failure (${error instanceof Error ? "Error" : "non-error"})\n`,
    );

    exitCode = EXIT_SOFTWARE;

    return exitCode;
  } finally {
    // The server has waited out its grace by now: whatever still keeps the process alive gets only
    // the slack before it is ended. A no-op when a signal armed the timer earlier.
    armForceExit(MCP_FORCE_EXIT_SLACK_MS);

    for (const { name, listener } of listeners) {
      io.signals.off(name, listener);
    }

    // Nothing reads stdin any more. A paused pipe that still holds unread bytes (after an oversized
    // message) would otherwise keep the process alive indefinitely; destroying it releases the
    // handle, and the process ends when its remaining work does.
    io.stdin.destroy();

    // Last, and bounded: a host that reads stderr gets the final lines; one that does not costs
    // this much and loses them.
    await application?.flushLogs(MCP_LOG_FLUSH_MS);
  }
}
