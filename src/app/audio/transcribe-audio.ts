import { detectAudioFormat, MAX_AUDIO_BYTES } from "../../domain/audio-format.js";
import { err, ok, type Result } from "../../domain/result.js";
import { type SpeechError, type SpeechErrorCode, speechError } from "../../domain/speech-error.js";
import type { AudioFiles, AudioReadFailure } from "../../ports/audio-files.js";
import type { Clock } from "../../ports/clock.js";
import type { Logger } from "../../ports/logger.js";
import type {
  AudioClip,
  SpeechServiceFailureCode,
  SpeechToText,
} from "../../ports/speech-to-text.js";
import { type SpeechDeadline, startSpeechDeadline } from "./speech-deadline.js";
import { interruptedFailure, type SpeechFailure, speechFailure } from "./speech-failure.js";

/** Transcribes one local audio file: the transcription, or a typed error. Never throws. */
export type TranscribeAudio = (
  path: string,
  signal: AbortSignal,
) => Promise<Result<string, SpeechError>>;

export interface TranscribeAudioLimits {
  /** The agent's input bound: a transcription is the turn's user text. */
  readonly maxTranscriptionChars: number;
  /** `SPEECH_TIMEOUT_MS`: one budget for reading the file and transcribing it. */
  readonly timeoutMs: number;
}

export interface TranscribeAudioDependencies {
  readonly files: AudioFiles;
  readonly speechToText: SpeechToText;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly limits: TranscribeAudioLimits;
}

type Outcome = Result<string, SpeechFailure>;

const READ_FAILURES = {
  unreadable: "audio_unreadable",
  too_large: "audio_too_large",
} satisfies { readonly [Failure in AudioReadFailure]: SpeechErrorCode };

const SERVICE_FAILURES = {
  unavailable: "transcription_unavailable",
  rejected: "transcription_rejected",
  protocol_error: "transcription_protocol_error",
} satisfies { readonly [Failure in SpeechServiceFailureCode]: SpeechErrorCode };

/** Reads the file within the application limit and recognises its format. */
async function readClip(
  dependencies: TranscribeAudioDependencies,
  path: string,
  deadline: SpeechDeadline,
): Promise<Result<AudioClip, SpeechFailure>> {
  const read = await deadline.step(() =>
    dependencies.files.read(path, MAX_AUDIO_BYTES, deadline.signal),
  );

  if (!read.ok) {
    return interruptedFailure(read.error, "transcription_timed_out");
  }

  if (!read.value.ok) {
    return speechFailure(READ_FAILURES[read.value.error]);
  }

  const bytes = read.value.value;

  // The adapter enforces the limit; the application owns it and checks again.
  if (bytes.byteLength > MAX_AUDIO_BYTES) {
    return speechFailure("audio_too_large", { problem: "read_exceeded_limit" });
  }

  const format = detectAudioFormat(bytes);

  return format === null ? speechFailure("audio_unsupported") : ok({ bytes, format });
}

async function transcribe(
  dependencies: TranscribeAudioDependencies,
  path: string,
  deadline: SpeechDeadline,
): Promise<Outcome> {
  const before = deadline.stopped();

  if (before !== undefined) {
    return interruptedFailure(before, "transcription_timed_out");
  }

  const clip = await readClip(dependencies, path, deadline);

  if (!clip.ok) {
    return clip;
  }

  const result = await deadline.step(() =>
    dependencies.speechToText.transcribe(clip.value, deadline.signal),
  );

  if (!result.ok) {
    return interruptedFailure(result.error, "transcription_timed_out");
  }

  if (!result.value.ok) {
    return speechFailure(SERVICE_FAILURES[result.value.error.code]);
  }

  const text = result.value.value;

  if (text.trim() === "") {
    return speechFailure("transcription_empty");
  }

  return text.length > dependencies.limits.maxTranscriptionChars
    ? speechFailure("transcription_too_long")
    : ok(text);
}

function logOutcome(logger: Logger, outcome: Outcome, durationMs: number): void {
  if (outcome.ok) {
    logger.info("transcription.completed", {
      outcome: "ok",
      durationMs,
      chars: outcome.value.length,
    });

    return;
  }

  const level = outcome.error.code === "internal_error" ? "error" : "warn";

  logger[level]("transcription.failed", {
    outcome: outcome.error.code,
    durationMs,
    ...outcome.error.details,
  });
}

/**
 * Speech-to-text for one file named by the CLI user: read within `MAX_AUDIO_BYTES`, recognise the
 * format from the content, transcribe, and accept only a non-blank transcription within the agent's
 * input bound. The text is returned unmodified. Logs one event with metadata only — never the path,
 * the audio, or the transcription.
 */
export function createTranscribeAudio(dependencies: TranscribeAudioDependencies): TranscribeAudio {
  return async (path: string, callerSignal: AbortSignal): Promise<Result<string, SpeechError>> => {
    const startedAt = dependencies.clock.monotonicNow();
    const deadline = startSpeechDeadline(callerSignal, dependencies.limits.timeoutMs);
    let outcome: Outcome;

    try {
      outcome = await transcribe(dependencies, path, deadline);
    } finally {
      deadline.clear();
    }

    logOutcome(dependencies.logger, outcome, dependencies.clock.monotonicNow() - startedAt);

    return outcome.ok ? outcome : err(speechError(outcome.error.code));
  };
}
