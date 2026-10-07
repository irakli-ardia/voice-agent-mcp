import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTranscribeAudio,
  type TranscribeAudioLimits,
} from "../../../../src/app/audio/transcribe-audio.js";
import { MAX_AUDIO_BYTES } from "../../../../src/domain/audio-format.js";
import { err, ok, type Result } from "../../../../src/domain/result.js";
import { type SpeechError, speechError } from "../../../../src/domain/speech-error.js";
import type { AudioFiles } from "../../../../src/ports/audio-files.js";
import {
  audioBytes,
  ftypBox,
  MP3_FRAME,
  WEBM_HEADER,
  wavFile,
} from "../../../helpers/audio-bytes.js";
import { createFakeAudioFiles, type FakeAudioFiles } from "../../../helpers/fake-audio-files.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import {
  createFakeSpeechToText,
  type FakeSpeechToText,
  type FakeTranscriptionReply,
  transcribesAs,
} from "../../../helpers/fake-speech-to-text.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";
import { untilAborted } from "../../../helpers/until-aborted.js";

const PATH = "question.wav";

const LIMITS: TranscribeAudioLimits = { maxTranscriptionChars: 20, timeoutMs: 5_000 };

interface HarnessOptions {
  readonly files?: ReadonlyMap<string, Uint8Array>;
  readonly read?: AudioFiles["read"];
  readonly reply?: FakeTranscriptionReply;
}

interface Harness {
  readonly run: (signal?: AbortSignal, path?: string) => Promise<Result<string, SpeechError>>;
  readonly files: FakeAudioFiles;
  readonly stt: FakeSpeechToText;
  readonly logger: RecordingLogger;
}

function harness(options: HarnessOptions = {}): Harness {
  const files = createFakeAudioFiles({
    files: options.files ?? new Map([[PATH, wavFile()]]),
    read: options.read,
  });

  const stt = createFakeSpeechToText(options.reply ?? transcribesAs("What time is it?"));
  const logger = createRecordingLogger();

  const transcribe = createTranscribeAudio({
    files,
    speechToText: stt,
    clock: createFakeClock(),
    logger,
    limits: LIMITS,
  });

  return {
    run: async (signal = new AbortController().signal, path = PATH) => transcribe(path, signal),
    files,
    stt,
    logger,
  };
}

const hangingRead: AudioFiles["read"] = async (_path, _maxBytes, signal) => untilAborted(signal);

const hangingReply: FakeTranscriptionReply = async (_audio, signal) => untilAborted(signal);

/** Ports that never settle at `stage` until the operation's signal aborts. */
function hangAt(stage: "read" | "stt"): HarnessOptions {
  return stage === "read" ? { read: hangingRead } : { reply: hangingReply };
}

function failure(code: SpeechError["code"]): Result<never, SpeechError> {
  return err(speechError(code));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  const leakedTimers = vi.getTimerCount();
  vi.useRealTimers();

  if (leakedTimers > 0) {
    throw new Error(`The test left ${leakedTimers} timer(s) running.`);
  }
});

describe("transcribe audio: success", () => {
  it("returns the transcription unmodified and sends the bytes with their format", async () => {
    const bytes = wavFile();

    const { run, stt, files } = harness({
      files: new Map([[PATH, bytes]]),
      reply: transcribesAs("  What time is it?\n"),
    });

    expect(await run()).toEqual(ok("  What time is it?\n"));
    expect(stt.calls).toEqual([{ bytes, format: "wav" }]);
    expect(files.calls.read).toBe(1);
  });

  it.each([
    ["mp3", audioBytes(MP3_FRAME, 64)],
    ["mp4", audioBytes(ftypBox("M4A "), 64)],
    ["webm", audioBytes(WEBM_HEADER, 64)],
  ])("passes the recognised format %s to speech-to-text", async (format, bytes) => {
    const { run, stt } = harness({ files: new Map([[PATH, bytes]]) });

    expect((await run()).ok).toBe(true);
    expect(stt.calls[0]?.format).toBe(format);
  });

  it("asks the file port for at most MAX_AUDIO_BYTES", async () => {
    const maxBytes: number[] = [];

    const { run } = harness({
      read: async (_path, max) => {
        maxBytes.push(max);

        return ok(wavFile());
      },
    });

    await run();

    expect(maxBytes).toEqual([MAX_AUDIO_BYTES]);
  });

  it("logs one completion event with metadata only", async () => {
    const { run, logger } = harness();

    await run();

    expect(logger.entries).toEqual([
      {
        level: "info",
        message: "transcription.completed",
        fields: { outcome: "ok", durationMs: 0, chars: 16 },
      },
    ]);
  });
});

describe("transcribe audio: the file", () => {
  it("accepts a file of exactly MAX_AUDIO_BYTES", async () => {
    const { run, stt } = harness({ files: new Map([[PATH, wavFile(MAX_AUDIO_BYTES)]]) });

    expect((await run()).ok).toBe(true);
    expect(stt.calls).toHaveLength(1);
  });

  it("rejects a file one byte over MAX_AUDIO_BYTES without transcribing it", async () => {
    const { run, stt } = harness({ files: new Map([[PATH, wavFile(MAX_AUDIO_BYTES + 1)]]) });

    expect(await run()).toEqual(failure("audio_too_large"));
    expect(stt.calls).toHaveLength(0);
  });

  it("re-checks the limit when the file port returns more than it was allowed to", async () => {
    const { run, stt, logger } = harness({
      read: async () => ok(wavFile(MAX_AUDIO_BYTES + 1)),
    });

    expect(await run()).toEqual(failure("audio_too_large"));
    expect(stt.calls).toHaveLength(0);
    expect(logger.entries[0]?.fields).toMatchObject({ problem: "read_exceeded_limit" });
  });

  it("reports an unreadable file", async () => {
    const { run, stt } = harness();

    expect(await run(undefined, "missing.wav")).toEqual(failure("audio_unreadable"));
    expect(stt.calls).toHaveLength(0);
  });

  it.each([
    ["an empty file", new Uint8Array(0)],
    ["text", new TextEncoder().encode("OPENAI_API_KEY=sk-never-uploaded\n")],
    ["FLAC", audioBytes([0x66, 0x4c, 0x61, 0x43], 64)],
  ])("never sends %s to speech-to-text", async (_name, bytes) => {
    const { run, stt } = harness({ files: new Map([[PATH, bytes]]) });

    expect(await run()).toEqual(failure("audio_unsupported"));
    expect(stt.calls).toHaveLength(0);
  });
});

describe("transcribe audio: the transcription", () => {
  it.each(["", " ", "\n\t "])("rejects the blank transcription %j", async (text) => {
    const { run } = harness({ reply: transcribesAs(text) });

    expect(await run()).toEqual(failure("transcription_empty"));
  });

  it("accepts a transcription of exactly the agent's input limit", async () => {
    const { run } = harness({ reply: transcribesAs("x".repeat(LIMITS.maxTranscriptionChars)) });

    expect((await run()).ok).toBe(true);
  });

  it("rejects a transcription one character over the agent's input limit", async () => {
    const { run } = harness({
      reply: transcribesAs("x".repeat(LIMITS.maxTranscriptionChars + 1)),
    });

    expect(await run()).toEqual(failure("transcription_too_long"));
  });

  it.each([
    ["unavailable", "transcription_unavailable"],
    ["rejected", "transcription_rejected"],
    ["protocol_error", "transcription_protocol_error"],
  ] as const)("maps the provider failure %s to %s", async (code, expected) => {
    const { run } = harness({ reply: async () => err({ code }) });

    expect(await run()).toEqual(failure(expected));
  });
});

describe("transcribe audio: cancellation and deadline", () => {
  it("does nothing for a caller that already cancelled", async () => {
    const controller = new AbortController();

    controller.abort();

    const { run, files, stt } = harness();

    expect(await run(controller.signal)).toEqual(failure("cancelled"));
    expect(files.calls.read).toBe(0);
    expect(stt.calls).toHaveLength(0);
  });

  it.each([
    ["the read", "read"],
    ["speech-to-text", "stt"],
  ] as const)("is cancelled when the caller aborts during %s", async (_name, stage) => {
    const controller = new AbortController();

    const { run, stt } = harness(hangAt(stage));

    const result = run(controller.signal);

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    expect(await result).toEqual(failure("cancelled"));
    expect(stt.calls).toHaveLength(stage === "read" ? 0 : 1);
  });

  it.each([
    ["the read", "read"],
    ["speech-to-text", "stt"],
  ] as const)("times out when the deadline passes during %s", async (_name, stage) => {
    const { run } = harness(hangAt(stage));

    const result = run();

    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);

    expect(await result).toEqual(failure("transcription_timed_out"));
  });

  it("drops a file read that finished after the caller cancelled, and never transcribes it", async () => {
    const controller = new AbortController();

    const { run, stt } = harness({
      read: async () => {
        controller.abort();

        return ok(wavFile());
      },
    });

    expect(await run(controller.signal)).toEqual(failure("cancelled"));
    expect(stt.calls).toHaveLength(0);
  });

  it("drops a transcription that arrived after the deadline", async () => {
    const { run } = harness({
      reply: async () => {
        vi.advanceTimersByTime(LIMITS.timeoutMs);

        return ok("What time is it?");
      },
    });

    expect(await run()).toEqual(failure("transcription_timed_out"));
  });

  it.each(["deadline first", "caller first"])(
    "lets caller cancellation win when both stop the operation (%s)",
    async (order) => {
      const controller = new AbortController();

      const { run } = harness({
        reply: async () => {
          if (order === "deadline first") {
            vi.advanceTimersByTime(LIMITS.timeoutMs);
            controller.abort();
          } else {
            controller.abort();
            vi.advanceTimersByTime(LIMITS.timeoutMs);
          }

          return ok("What time is it?");
        },
      });

      expect(await run(controller.signal)).toEqual(failure("cancelled"));
    },
  );

  it("passes one composed signal that aborts on the deadline to both ports", async () => {
    const signals: AbortSignal[] = [];

    const { run } = harness({
      read: async (_path, _max, signal) => {
        signals.push(signal);

        return ok(wavFile());
      },
      reply: async (_audio, signal) => {
        signals.push(signal);

        return untilAborted(signal);
      },
    });

    const result = run();

    await vi.advanceTimersByTimeAsync(LIMITS.timeoutMs);
    await result;

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("transcribe audio: broken ports", () => {
  it.each([
    ["the file port", "read"],
    ["speech-to-text", "stt"],
  ] as const)("reports %s rejecting without an abort as internal_error", async (_name, stage) => {
    const broken = async (): Promise<never> => Promise.reject(new Error("broken"));

    const { run, logger } = harness(stage === "read" ? { read: broken } : { reply: broken });

    expect(await run()).toEqual(failure("internal_error"));
    expect(logger.entries).toEqual([
      {
        level: "error",
        message: "transcription.failed",
        fields: {
          outcome: "internal_error",
          durationMs: 0,
          problem: "port_rejected_without_abort",
        },
      },
    ]);
  });
});

describe("transcribe audio: privacy", () => {
  it("never logs the path, the audio, or the transcription", async () => {
    const sentinel = "SENTINEL-7f3a";
    const path = `C:\\Users\\${sentinel}\\question.wav`;
    const bytes = wavFile();

    for (const reply of [transcribesAs(`Note for ${sentinel}`), transcribesAs(" ")]) {
      const { run, logger } = harness({ files: new Map([[path, bytes]]), reply });

      await run(undefined, path);

      const logged = JSON.stringify(logger.entries);

      expect(logger.entries).toHaveLength(1);
      expect(logged).not.toContain(sentinel);
      expect(logged).not.toContain("question.wav");
      expect(logged).not.toContain("RIFF");
    }
  });
});
