import type { AudioFormat } from "../domain/audio-format.js";
import type { Result } from "../domain/result.js";

/** Audio bytes in a format the application recognised from their content. */
export interface AudioClip {
  readonly bytes: Uint8Array;
  readonly format: AudioFormat;
}

/** How a speech provider call failed, after any retries: a code only, never provider text. */
export type SpeechServiceFailureCode = "unavailable" | "rejected" | "protocol_error";

export interface SpeechServiceFailure {
  readonly code: SpeechServiceFailureCode;
}

/**
 * Turns speech into text. `transcribe` resolves for every outcome, retries transient failures
 * itself, and rejects only when `signal` aborts. The text is returned exactly as the provider gave
 * it; the caller decides whether it is usable.
 */
export interface SpeechToText {
  transcribe(audio: AudioClip, signal: AbortSignal): Promise<Result<string, SpeechServiceFailure>>;
}
