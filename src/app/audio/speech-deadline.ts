import { err, ok, type Result } from "../../domain/result.js";

/** Why a speech operation must stop: the caller cancelled, or its deadline passed. */
export type SpeechStop = "cancelled" | "timed_out";

/** A port call that did not resolve: a stop, or a rejection without one (a broken port contract). */
export type InterruptedCall = SpeechStop | "rejected_without_abort";

/**
 * The deadline of one speech operation: `SPEECH_TIMEOUT_MS` over every step, composed with the
 * caller's signal. Outcomes are decided from the abort flags, never from which promise settled
 * first, and the caller wins when both stopped.
 */
export interface SpeechDeadline {
  /** Aborts when the caller cancels or the deadline passes; handed to every port call. */
  readonly signal: AbortSignal;
  /** The reason to stop, or `undefined` while the operation may continue. */
  stopped(): SpeechStop | undefined;
  /**
   * A port call whose value is used only while the operation continues: a rejection becomes the
   * stop reason (or a broken contract), and a stop that happened while it ran wins over its value.
   */
  step<T>(start: () => Promise<T>): Promise<Result<T, InterruptedCall>>;
  /**
   * A port call that is the commit point: once it resolves, its value stands even if a stop
   * happened meanwhile. A rejection is handled as in `step`.
   */
  commit<T>(start: () => Promise<T>): Promise<Result<T, InterruptedCall>>;
  /** Stops the timer; call once the operation has settled. */
  clear(): void;
}

export function startSpeechDeadline(callerSignal: AbortSignal, timeoutMs: number): SpeechDeadline {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);

  const stopped = (): SpeechStop | undefined => {
    if (callerSignal.aborted) {
      return "cancelled";
    }

    return deadline.signal.aborted ? "timed_out" : undefined;
  };

  const commit = async <T>(start: () => Promise<T>): Promise<Result<T, InterruptedCall>> => {
    try {
      return ok(await start());
    } catch {
      return err(stopped() ?? "rejected_without_abort");
    }
  };

  return {
    signal: AbortSignal.any([callerSignal, deadline.signal]),
    stopped,
    step: async <T>(start: () => Promise<T>): Promise<Result<T, InterruptedCall>> => {
      const outcome = await commit(start);
      const stop = stopped();

      return outcome.ok && stop !== undefined ? err(stop) : outcome;
    },
    commit,
    clear: (): void => clearTimeout(timer),
  };
}
