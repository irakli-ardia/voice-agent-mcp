import type { Result } from "../domain/result.js";
import type { SpeechServiceFailureCode } from "./speech-to-text.js";

/** Rendered speech for one text. */
export interface SynthesizedSpeech {
  /** A complete WAV file: PCM, 16-bit signed little-endian, mono, 24 000 Hz. */
  readonly wav: Uint8Array;
  /**
   * The text the provider reports it spoke. A provider that speaks its input exactly returns the
   * input; a generative renderer returns its own transcript, which the caller checks.
   */
  readonly spokenText: string;
}

/** `incomplete`: the provider stopped before finishing the audio. */
export type TextToSpeechFailureCode = SpeechServiceFailureCode | "incomplete";

export interface TextToSpeechFailure {
  readonly code: TextToSpeechFailureCode;
}

/**
 * Renders an already-final text as speech; it never decides content. `synthesize` resolves for
 * every outcome and rejects only when `signal` aborts.
 */
export interface TextToSpeech {
  synthesize(
    text: string,
    signal: AbortSignal,
  ): Promise<Result<SynthesizedSpeech, TextToSpeechFailure>>;
}
