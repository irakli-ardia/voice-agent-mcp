import { describe, expect, it } from "vitest";
import {
  MAX_SPEECH_TEXT_CHARS,
  type SpeechErrorCode,
  speechError,
} from "../../../src/domain/speech-error.js";

const CODES: readonly SpeechErrorCode[] = [
  "audio_unreadable",
  "audio_too_large",
  "audio_unsupported",
  "transcription_empty",
  "transcription_too_long",
  "transcription_unavailable",
  "transcription_rejected",
  "transcription_protocol_error",
  "transcription_timed_out",
  "synthesis_text_too_long",
  "synthesis_unavailable",
  "synthesis_rejected",
  "synthesis_incomplete",
  "synthesis_unfaithful",
  "synthesis_protocol_error",
  "synthesis_timed_out",
  "speech_output_exists",
  "speech_output_failed",
  "cancelled",
  "internal_error",
];

describe("speechError", () => {
  it.each(CODES)("gives %s a static, single-line message", (code) => {
    const error = speechError(code);

    expect(error.code).toBe(code);
    expect(error.message).toMatch(/^[A-Z][^\n]{9,120}\.$/);
    expect(speechError(code)).toEqual(error);
  });

  it("gives every code its own message", () => {
    expect(new Set(CODES.map((code) => speechError(code).message)).size).toBe(CODES.length);
  });

  it("states the limits the messages mention", () => {
    expect(MAX_SPEECH_TEXT_CHARS).toBe(800);
    expect(speechError("synthesis_text_too_long").message).toContain("800");
    expect(speechError("audio_too_large").message).toContain("8 MiB");
  });
});
