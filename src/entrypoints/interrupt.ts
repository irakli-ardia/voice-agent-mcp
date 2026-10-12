import { EXIT_INTERRUPTED, EXIT_TERMINATED } from "./exit-codes.js";

type StopSignal = "SIGINT" | "SIGTERM";

/**
 * How long a stopped or finished command may take to leave before it is ended for it: the same
 * 2 s grace and 0.5 s slack as `voice-agent mcp`. It bounds work a tool already started (a note
 * still committing, a call blocked in the filesystem), which JavaScript cannot stop.
 */
export const COMMAND_SHUTDOWN_BOUND_MS = 2_500;

/** The part of `process` that delivers stop signals; tests pass an `EventEmitter`. */
export interface StopSignalSource {
  on(event: StopSignal, listener: () => void): void;
  off(event: StopSignal, listener: () => void): void;
}

export interface StopIo {
  readonly signals: StopSignalSource;
  /**
   * Ends the process now with this code. Called at most once, by the bin only: nothing else in the
   * application may end the process. Whatever was still running is interrupted.
   */
  readonly forceExit: (code: number) => void;
  readonly stderr: (text: string) => void;
}

const SIGNAL_CODE: Readonly<Record<StopSignal, number>> = {
  SIGINT: EXIT_INTERRUPTED,
  SIGTERM: EXIT_TERMINATED,
};

const STOP_SIGNALS: readonly StopSignal[] = ["SIGINT", "SIGTERM"];

/**
 * Runs a command that can be stopped, and resolves to its exit code.
 *
 * - The first SIGINT or SIGTERM aborts the signal given to `run`, so a turn stops cleanly and its
 *   tools are told to stop; the exit code is the command's own (130 for a cancelled turn), or 143
 *   when the signal was SIGTERM.
 * - A second signal ends the process at once with the first one's code, as a second Ctrl+C always
 *   has.
 * - Whatever the cause, the process is ended for the command if it is still alive
 *   `COMMAND_SHUTDOWN_BOUND_MS` after the first signal, or after `run` finished. The timer does not
 *   keep the process alive, so a command that ends by itself is never held for it.
 *
 * It never ends the process itself: it calls the `forceExit` it was given, which only the bin may.
 */
export async function runUntilStopped(
  run: (signal: AbortSignal) => Promise<number>,
  io: StopIo,
): Promise<number> {
  const controller = new AbortController();
  let requested: StopSignal | undefined;
  let backstop: NodeJS.Timeout | undefined;
  let exitCode: number | undefined;

  const currentCode = (): number =>
    exitCode ?? (requested === undefined ? EXIT_INTERRUPTED : SIGNAL_CODE[requested]);

  const arm = (): void => {
    backstop ??= setTimeout(() => {
      io.stderr("error: the command did not finish in time and was ended\n");
      io.forceExit(currentCode());
    }, COMMAND_SHUTDOWN_BOUND_MS);
    backstop.unref();
  };

  const listeners = STOP_SIGNALS.map((name) => ({
    name,
    listener: (): void => {
      if (requested !== undefined) {
        io.forceExit(currentCode());

        return;
      }

      requested = name;
      arm();
      controller.abort();
    },
  }));

  for (const { name, listener } of listeners) {
    io.signals.on(name, listener);
  }

  try {
    const code = await run(controller.signal);

    exitCode = requested === "SIGTERM" && code === EXIT_INTERRUPTED ? EXIT_TERMINATED : code;

    return exitCode;
  } finally {
    for (const { name, listener } of listeners) {
      io.signals.off(name, listener);
    }

    arm();
  }
}
