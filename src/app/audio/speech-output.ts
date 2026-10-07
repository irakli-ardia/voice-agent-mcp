import { err, ok, type Result } from "../../domain/result.js";
import {
  MAX_SPEECH_TEXT_CHARS,
  type SpeechError,
  type SpeechErrorCode,
  speechError,
} from "../../domain/speech-error.js";
import type {
  AudioFiles,
  AudioReserveFailure,
  ReservedAudioFile,
} from "../../ports/audio-files.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type { TextToSpeech, TextToSpeechFailureCode } from "../../ports/text-to-speech.js";
import { type SpeechDeadline, startSpeechDeadline } from "./speech-deadline.js";
import { interruptedFailure, type SpeechFailure, speechFailure } from "./speech-failure.js";
import { spokenTextMatches } from "./spoken-text-matches.js";

/**
 * A reserved output file waiting for the answer. `save` renders the answer, checks the renderer
 * said exactly that, and commits the file; on any failure it discards the file itself. `discard`
 * removes a file that was reserved but never saved; it is idempotent and does nothing after
 * `save` was called.
 */
export interface SpeechOutput {
  save(text: string, signal: AbortSignal): Promise<Result<void, SpeechError>>;
  discard(): Promise<void>;
}

/**
 * Reserves the output file before any provider spend: created exclusively, never replacing
 * anything. Never throws.
 */
export type ReserveSpeechOutput = (
  path: string,
  signal: AbortSignal,
) => Promise<Result<SpeechOutput, SpeechError>>;

export interface SpeechOutputDependencies {
  readonly files: AudioFiles;
  readonly textToSpeech: TextToSpeech;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `SPEECH_TIMEOUT_MS`: one budget for rendering and writing the file. */
  readonly timeoutMs: number;
}

const RESERVE_FAILURES = {
  exists: "speech_output_exists",
  failed: "speech_output_failed",
} satisfies { readonly [Failure in AudioReserveFailure]: SpeechErrorCode };

const SERVICE_FAILURES = {
  unavailable: "synthesis_unavailable",
  rejected: "synthesis_rejected",
  incomplete: "synthesis_incomplete",
  protocol_error: "synthesis_protocol_error",
} satisfies { readonly [Failure in TextToSpeechFailureCode]: SpeechErrorCode };

/** Renders `text`, checks fidelity, and writes the WAV; the write is the commit point. */
async function render(
  dependencies: SpeechOutputDependencies,
  file: ReservedAudioFile,
  text: string,
  deadline: SpeechDeadline,
): Promise<Result<number, SpeechFailure>> {
  const before = deadline.stopped();

  if (before !== undefined) {
    return interruptedFailure(before, "synthesis_timed_out");
  }

  if (text.length > MAX_SPEECH_TEXT_CHARS) {
    return speechFailure("synthesis_text_too_long");
  }

  const speech = await deadline.step(() =>
    dependencies.textToSpeech.synthesize(text, deadline.signal),
  );

  if (!speech.ok) {
    return interruptedFailure(speech.error, "synthesis_timed_out");
  }

  if (!speech.value.ok) {
    return speechFailure(SERVICE_FAILURES[speech.value.error.code]);
  }

  const { wav, spokenText } = speech.value.value;

  // The answer is decided by the agent; the renderer may only say it.
  if (!spokenTextMatches(text, spokenText)) {
    return speechFailure("synthesis_unfaithful", { spokenTextMatched: false });
  }

  const written = await deadline.commit(() => file.write(wav, deadline.signal));

  if (!written.ok) {
    return interruptedFailure(written.error, "synthesis_timed_out");
  }

  return written.value.ok ? ok(wav.byteLength) : speechFailure("speech_output_failed");
}

/** Removes the file, logging (never throwing) if the port breaks its never-rejects contract. */
async function discardFile(logger: Logger, file: ReservedAudioFile): Promise<void> {
  try {
    await file.discard();
  } catch {
    logger.error("speech_output.discard_failed", { problem: "port_rejected" });
  }
}

function logSave(logger: Logger, outcome: Result<number, SpeechFailure>, durationMs: number): void {
  if (outcome.ok) {
    logger.info("synthesis.completed", {
      outcome: "ok",
      durationMs,
      wavBytes: outcome.value,
      spokenTextMatched: true,
    });

    return;
  }

  const level = outcome.error.code === "internal_error" ? "error" : "warn";

  logger[level]("synthesis.failed", {
    outcome: outcome.error.code,
    durationMs,
    ...outcome.error.details,
  });
}

function createSpeechOutput(
  dependencies: SpeechOutputDependencies,
  file: ReservedAudioFile,
): SpeechOutput {
  let state: "reserved" | "saving" | "done" = "reserved";

  return {
    save: async (text: string, callerSignal: AbortSignal): Promise<Result<void, SpeechError>> => {
      if (state !== "reserved") {
        dependencies.logger.error("synthesis.failed", {
          outcome: "internal_error",
          problem: "not_reserved",
        });

        return err(speechError("internal_error"));
      }

      state = "saving";

      const startedAt = dependencies.clock.monotonicNow();
      const deadline = startSpeechDeadline(callerSignal, dependencies.timeoutMs);
      let outcome: Result<number, SpeechFailure>;

      try {
        outcome = await render(dependencies, file, text, deadline);
      } finally {
        deadline.clear();
      }

      if (!outcome.ok) {
        await discardFile(dependencies.logger, file);
      }

      state = "done";
      logSave(dependencies.logger, outcome, dependencies.clock.monotonicNow() - startedAt);

      return outcome.ok ? ok(undefined) : err(speechError(outcome.error.code));
    },
    discard: async (): Promise<void> => {
      if (state !== "reserved") {
        return;
      }

      state = "done";
      await discardFile(dependencies.logger, file);
    },
  };
}

/**
 * The speech output of one command: reserve the file first, then save the final answer as speech.
 * The renderer never decides content: audio is committed only when the provider's spoken text
 * matches the answer word for word. Logs metadata only — never the path, text, or audio.
 */
export function createReserveSpeechOutput(
  dependencies: SpeechOutputDependencies,
): ReserveSpeechOutput {
  return async (path: string, signal: AbortSignal): Promise<Result<SpeechOutput, SpeechError>> => {
    if (signal.aborted) {
      return err(speechError("cancelled"));
    }

    let reserved: Result<ReservedAudioFile, AudioReserveFailure>;

    try {
      reserved = await dependencies.files.reserve(path, signal);
    } catch {
      const code = signal.aborted ? "cancelled" : "internal_error";

      dependencies.logger[code === "cancelled" ? "warn" : "error"]("speech_output.reserve_failed", {
        outcome: code,
      });

      return err(speechError(code));
    }

    if (!reserved.ok) {
      const code = RESERVE_FAILURES[reserved.error];

      dependencies.logger.warn("speech_output.reserve_failed", { outcome: code });

      return err(speechError(code));
    }

    // Cancelled while the file was being created: nothing may stay behind.
    if (signal.aborted) {
      await discardFile(dependencies.logger, reserved.value);

      return err(speechError("cancelled"));
    }

    return ok(createSpeechOutput(dependencies, reserved.value));
  };
}
