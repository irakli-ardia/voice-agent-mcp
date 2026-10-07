/**
 * Every way a speech operation (transcribing an audio file, or rendering and saving the answer as
 * speech) can end without its result. `cancelled` and the `*_timed_out` codes stop the operation
 * wherever it is.
 */
export type SpeechErrorCode =
  | "audio_unreadable"
  | "audio_too_large"
  | "audio_unsupported"
  | "transcription_empty"
  | "transcription_too_long"
  | "transcription_unavailable"
  | "transcription_rejected"
  | "transcription_protocol_error"
  | "transcription_timed_out"
  | "synthesis_text_too_long"
  | "synthesis_unavailable"
  | "synthesis_rejected"
  | "synthesis_incomplete"
  | "synthesis_unfaithful"
  | "synthesis_protocol_error"
  | "synthesis_timed_out"
  | "speech_output_exists"
  | "speech_output_failed"
  | "cancelled"
  | "internal_error";

/** A failed speech operation. `message` is static and safe to show the user. */
export interface SpeechError {
  readonly code: SpeechErrorCode;
  readonly message: string;
}

/**
 * Longest answer the speech renderer is given, in UTF-16 code units: about 130 English words, or
 * 45–50 s of speech at the measured pace (≈ 17 characters per second). Longer answers are not
 * rendered. Chosen with `SPEECH_TIMEOUT_MS` from live rendering latency.
 */
export const MAX_SPEECH_TEXT_CHARS = 800;

const MESSAGES = {
  audio_unreadable: "The audio file could not be read.",
  audio_too_large: "The audio file is larger than this application accepts (8 MiB).",
  audio_unsupported: "The audio file is not WAV, MP3, MP4/M4A, or WebM audio.",
  transcription_empty: "No speech was recognised in the audio.",
  transcription_too_long: "The transcribed request is longer than MAX_INPUT_TEXT_CHARS.",
  transcription_unavailable: "The speech-to-text service is unavailable. Try again later.",
  transcription_rejected: "The speech-to-text service rejected the request.",
  transcription_protocol_error:
    "The speech-to-text service returned a response this application cannot use.",
  transcription_timed_out: "Transcription did not finish within its time limit.",
  synthesis_text_too_long: "The answer is too long to speak (more than 800 characters).",
  synthesis_unavailable: "The speech service is unavailable. Try again later.",
  synthesis_rejected: "The speech service rejected the request.",
  synthesis_incomplete: "The speech service did not finish the audio.",
  synthesis_unfaithful: "The generated speech did not match the answer, so it was not saved.",
  synthesis_protocol_error: "The speech service returned a response this application cannot use.",
  synthesis_timed_out: "Speech generation did not finish within its time limit.",
  speech_output_exists: "The speech output file already exists.",
  speech_output_failed: "The speech output file could not be written.",
  cancelled: "The request was cancelled.",
  internal_error: "The request failed unexpectedly.",
} satisfies { readonly [Code in SpeechErrorCode]: string };

/** The error for `code`, with its static message. */
export function speechError(code: SpeechErrorCode): SpeechError {
  return { code, message: MESSAGES[code] };
}
