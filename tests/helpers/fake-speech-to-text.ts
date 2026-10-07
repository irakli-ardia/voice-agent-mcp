import { ok, type Result } from "../../src/domain/result.js";
import type {
  AudioClip,
  SpeechServiceFailure,
  SpeechToText,
} from "../../src/ports/speech-to-text.js";

export type FakeTranscriptionReply = (
  audio: AudioClip,
  signal: AbortSignal,
) => Promise<Result<string, SpeechServiceFailure>>;

export interface FakeSpeechToText extends SpeechToText {
  /** Every clip `transcribe` received, in order. */
  readonly calls: readonly AudioClip[];
}

/** Replies with `text` for every clip. */
export function transcribesAs(text: string): FakeTranscriptionReply {
  return async () => ok(text);
}

/** A `SpeechToText` with no provider behind it: every call runs `reply`. */
export function createFakeSpeechToText(reply: FakeTranscriptionReply): FakeSpeechToText {
  const calls: AudioClip[] = [];

  return {
    calls,
    transcribe: async (audio, signal) => {
      calls.push(audio);

      return reply(audio, signal);
    },
  };
}
