import { ok, type Result } from "../../src/domain/result.js";
import type {
  SynthesizedSpeech,
  TextToSpeech,
  TextToSpeechFailure,
} from "../../src/ports/text-to-speech.js";

export type FakeSpeechReply = (
  text: string,
  signal: AbortSignal,
) => Promise<Result<SynthesizedSpeech, TextToSpeechFailure>>;

export interface FakeTextToSpeech extends TextToSpeech {
  /** Every text `synthesize` received, in order. */
  readonly calls: readonly string[];
}

/** The bytes every fake rendering returns; the app never inspects them. */
export const FAKE_WAV = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);

/** A renderer that reports `spokenText` for whatever it was given. */
export function speaks(spokenText: string): FakeSpeechReply {
  return async () => ok({ wav: FAKE_WAV, spokenText });
}

/** A faithful renderer: it reports speaking exactly its input. */
export const speaksExactly: FakeSpeechReply = async (text) =>
  ok({ wav: FAKE_WAV, spokenText: text });

/** A `TextToSpeech` with no provider behind it: every call runs `reply`. */
export function createFakeTextToSpeech(reply: FakeSpeechReply = speaksExactly): FakeTextToSpeech {
  const calls: string[] = [];

  return {
    calls,
    synthesize: async (text, signal) => {
      calls.push(text);

      return reply(text, signal);
    },
  };
}
