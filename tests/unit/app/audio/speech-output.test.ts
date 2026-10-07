import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReserveSpeechOutput,
  type SpeechOutput,
} from "../../../../src/app/audio/speech-output.js";
import { err, ok, type Result } from "../../../../src/domain/result.js";
import {
  MAX_SPEECH_TEXT_CHARS,
  type SpeechError,
  speechError,
} from "../../../../src/domain/speech-error.js";
import { wavFile } from "../../../helpers/audio-bytes.js";
import {
  createFakeAudioFiles,
  type FakeAudioFiles,
  type FakeAudioFilesOptions,
} from "../../../helpers/fake-audio-files.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import {
  createFakeTextToSpeech,
  FAKE_WAV,
  type FakeSpeechReply,
  type FakeTextToSpeech,
  speaks,
  speaksExactly,
} from "../../../helpers/fake-text-to-speech.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";
import { untilAborted } from "../../../helpers/until-aborted.js";

const PATH = "answer.wav";

const ANSWER = "It is 3 PM.";

const TIMEOUT_MS = 5_000;

interface Harness {
  readonly reserve: (signal?: AbortSignal) => Promise<Result<SpeechOutput, SpeechError>>;
  readonly files: FakeAudioFiles;
  readonly tts: FakeTextToSpeech;
  readonly logger: RecordingLogger;
}

function harness(
  files: FakeAudioFilesOptions = {},
  reply: FakeSpeechReply = speaksExactly,
): Harness {
  const fakeFiles = createFakeAudioFiles(files);
  const tts = createFakeTextToSpeech(reply);
  const logger = createRecordingLogger();

  const reserveOutput = createReserveSpeechOutput({
    files: fakeFiles,
    textToSpeech: tts,
    clock: createFakeClock(),
    logger,
    timeoutMs: TIMEOUT_MS,
  });

  return {
    reserve: async (signal = new AbortController().signal) => reserveOutput(PATH, signal),
    files: fakeFiles,
    tts,
    logger,
  };
}

/** Reserves the output, failing the test if reservation does not succeed. */
async function reserved(subject: Harness): Promise<SpeechOutput> {
  const output = await subject.reserve();

  if (!output.ok) {
    throw new Error(`reservation failed: ${output.error.code}`);
  }

  return output.value;
}

function failure(code: SpeechError["code"]): Result<never, SpeechError> {
  return err(speechError(code));
}

function stateOf(subject: Harness): string | undefined {
  return subject.files.reservations.get(PATH)?.state;
}

const hangingReply: FakeSpeechReply = async (_text, signal) => untilAborted(signal);

const hangingCommit = async (signal: AbortSignal): Promise<void> => untilAborted(signal);

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

describe("speech output: reservation comes before any rendering", () => {
  it("reserves the file without rendering anything", async () => {
    const subject = harness();

    expect((await subject.reserve()).ok).toBe(true);
    expect(stateOf(subject)).toBe("reserved");
    expect(subject.tts.calls).toHaveLength(0);
  });

  it("refuses an existing file, leaves it untouched, and renders nothing", async () => {
    const existing = wavFile();
    const subject = harness({ files: new Map([[PATH, existing]]) });

    expect(await subject.reserve()).toEqual(failure("speech_output_exists"));
    expect(subject.files.reservations.size).toBe(0);
    expect(subject.tts.calls).toHaveLength(0);
  });

  it("reports a file that could not be created", async () => {
    const subject = harness({ reserveFails: true });

    expect(await subject.reserve()).toEqual(failure("speech_output_failed"));
    expect(subject.logger.entries).toEqual([
      {
        level: "warn",
        message: "speech_output.reserve_failed",
        fields: { outcome: "speech_output_failed" },
      },
    ]);
  });

  it("does nothing for a caller that already cancelled", async () => {
    const controller = new AbortController();

    controller.abort();

    const subject = harness();

    expect(await subject.reserve(controller.signal)).toEqual(failure("cancelled"));
    expect(subject.files.calls.reserve).toBe(0);
  });

  it("is cancelled when the caller aborts while the file is being created", async () => {
    const controller = new AbortController();
    const subject = harness({ beforeReserve: async (signal) => untilAborted(signal) });
    const result = subject.reserve(controller.signal);

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    expect(await result).toEqual(failure("cancelled"));
    expect(subject.files.reservations.size).toBe(0);
  });

  it("discards a file created just as the caller cancelled", async () => {
    const controller = new AbortController();

    const subject = harness({
      beforeReserve: async () => {
        controller.abort();
      },
    });

    expect(await subject.reserve(controller.signal)).toEqual(failure("cancelled"));
    expect(stateOf(subject)).toBe("discarded");
  });

  it("reports a reservation that rejects without an abort as internal_error", async () => {
    const subject = harness({
      beforeReserve: async () => {
        throw new Error("broken");
      },
    });

    expect(await subject.reserve()).toEqual(failure("internal_error"));
    expect(subject.logger.entries[0]).toMatchObject({
      level: "error",
      fields: { outcome: "internal_error" },
    });
  });
});

describe("speech output: saving", () => {
  it("renders the answer and commits exactly the rendered audio", async () => {
    const subject = harness();
    const output = await reserved(subject);

    expect(await output.save(ANSWER, new AbortController().signal)).toEqual(ok(undefined));
    expect(subject.tts.calls).toEqual([ANSWER]);
    expect(subject.files.reservations.get(PATH)).toEqual({ state: "committed", bytes: FAKE_WAV });
    expect(subject.logger.entries).toEqual([
      {
        level: "info",
        message: "synthesis.completed",
        fields: {
          outcome: "ok",
          durationMs: 0,
          wavBytes: FAKE_WAV.byteLength,
          spokenTextMatched: true,
        },
      },
    ]);
  });

  it("accepts spoken text that differs only in representation", async () => {
    const subject = harness({}, speaks("it is 3 pm"));
    const output = await reserved(subject);

    expect((await output.save(ANSWER, new AbortController().signal)).ok).toBe(true);
    expect(stateOf(subject)).toBe("committed");
  });

  it("renders an answer of exactly MAX_SPEECH_TEXT_CHARS", async () => {
    const subject = harness();
    const output = await reserved(subject);
    const text = "a".repeat(MAX_SPEECH_TEXT_CHARS);

    expect((await output.save(text, new AbortController().signal)).ok).toBe(true);
    expect(subject.tts.calls).toEqual([text]);
  });

  it("refuses an answer one character longer without rendering, and discards the file", async () => {
    const subject = harness();
    const output = await reserved(subject);

    expect(
      await output.save("a".repeat(MAX_SPEECH_TEXT_CHARS + 1), new AbortController().signal),
    ).toEqual(failure("synthesis_text_too_long"));
    expect(subject.tts.calls).toHaveLength(0);
    expect(stateOf(subject)).toBe("discarded");
  });

  it.each([
    ["unavailable", "synthesis_unavailable"],
    ["rejected", "synthesis_rejected"],
    ["incomplete", "synthesis_incomplete"],
    ["protocol_error", "synthesis_protocol_error"],
  ] as const)(
    "maps the renderer failure %s to %s and discards the file",
    async (code, expected) => {
      const subject = harness({}, async () => err({ code }));
      const output = await reserved(subject);

      expect(await output.save(ANSWER, new AbortController().signal)).toEqual(failure(expected));
      expect(stateOf(subject)).toBe("discarded");
      expect(subject.files.calls.write).toBe(0);
    },
  );

  it.each([
    ["an added sentence", "It is 3 PM. Anything else?"],
    ["digits read as words", "It is three PM."],
    ["an answer to the text", "Sure."],
    ["silence", ""],
  ])("refuses a rendering with %s: never written, file discarded", async (_name, spoken) => {
    const subject = harness({}, speaks(spoken));
    const output = await reserved(subject);

    expect(await output.save(ANSWER, new AbortController().signal)).toEqual(
      failure("synthesis_unfaithful"),
    );
    expect(subject.files.calls.write).toBe(0);
    expect(stateOf(subject)).toBe("discarded");
    expect(subject.logger.entries).toEqual([
      {
        level: "warn",
        message: "synthesis.failed",
        fields: { outcome: "synthesis_unfaithful", durationMs: 0, spokenTextMatched: false },
      },
    ]);
  });

  it("discards the file when writing fails", async () => {
    const subject = harness({ writeFails: true });
    const output = await reserved(subject);

    expect(await output.save(ANSWER, new AbortController().signal)).toEqual(
      failure("speech_output_failed"),
    );
    expect(stateOf(subject)).toBe("discarded");
  });

  it("saves only once", async () => {
    const subject = harness();
    const output = await reserved(subject);

    await output.save(ANSWER, new AbortController().signal);

    expect(await output.save(ANSWER, new AbortController().signal)).toEqual(
      failure("internal_error"),
    );
    expect(subject.tts.calls).toHaveLength(1);
    expect(stateOf(subject)).toBe("committed");
  });
});

describe("speech output: discard", () => {
  it("removes a reserved file once, however often it is called", async () => {
    const subject = harness();
    const output = await reserved(subject);

    await output.discard();
    await output.discard();

    expect(stateOf(subject)).toBe("discarded");
    expect(subject.files.calls.discard).toBe(1);
  });

  it("never touches a committed file", async () => {
    const subject = harness();
    const output = await reserved(subject);

    await output.save(ANSWER, new AbortController().signal);
    await output.discard();

    expect(stateOf(subject)).toBe("committed");
    expect(subject.files.calls.discard).toBe(0);
  });

  it("leaves a save in progress alone: the save owns the file until it settles", async () => {
    const controller = new AbortController();
    const subject = harness({}, hangingReply);
    const output = await reserved(subject);
    const saving = output.save(ANSWER, controller.signal);

    await vi.advanceTimersByTimeAsync(10);
    await output.discard();

    expect(subject.files.calls.discard).toBe(0);
    expect(stateOf(subject)).toBe("reserved");

    controller.abort();
    await saving;

    expect(subject.files.calls.discard).toBe(1);
  });

  it("refuses a second save while the first is still running", async () => {
    const controller = new AbortController();
    const subject = harness({}, hangingReply);
    const output = await reserved(subject);
    const first = output.save(ANSWER, controller.signal);

    await vi.advanceTimersByTimeAsync(10);

    expect(await output.save(ANSWER, new AbortController().signal)).toEqual(
      failure("internal_error"),
    );
    expect(subject.tts.calls).toHaveLength(1);

    controller.abort();

    expect(await first).toEqual(failure("cancelled"));
  });

  it("does not discard again after a failed save already did", async () => {
    const subject = harness({}, speaks("Something else."));
    const output = await reserved(subject);

    await output.save(ANSWER, new AbortController().signal);
    await output.discard();

    expect(subject.files.calls.discard).toBe(1);
  });

  it("logs, and does not throw, when the file port breaks its never-rejects contract", async () => {
    const subject = harness({ discardRejects: true });
    const output = await reserved(subject);

    await expect(output.discard()).resolves.toBeUndefined();
    expect(subject.logger.entries).toEqual([
      {
        level: "error",
        message: "speech_output.discard_failed",
        fields: { problem: "port_rejected" },
      },
    ]);
  });
});

describe("speech output: cancellation, deadline, and the commit point", () => {
  it("renders nothing for a caller that already cancelled, and discards the file", async () => {
    const controller = new AbortController();
    const subject = harness();
    const output = await reserved(subject);

    controller.abort();

    expect(await output.save(ANSWER, controller.signal)).toEqual(failure("cancelled"));
    expect(subject.tts.calls).toHaveLength(0);
    expect(stateOf(subject)).toBe("discarded");
  });

  it("is cancelled when the caller aborts during rendering", async () => {
    const controller = new AbortController();
    const subject = harness({}, hangingReply);
    const output = await reserved(subject);
    const result = output.save(ANSWER, controller.signal);

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    expect(await result).toEqual(failure("cancelled"));
    expect(stateOf(subject)).toBe("discarded");
  });

  it("times out when the deadline passes during rendering", async () => {
    const subject = harness({}, hangingReply);
    const output = await reserved(subject);
    const result = output.save(ANSWER, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(await result).toEqual(failure("synthesis_timed_out"));
    expect(stateOf(subject)).toBe("discarded");
  });

  it("drops a rendering that finished after the caller cancelled, and never writes it", async () => {
    const controller = new AbortController();

    const subject = harness({}, async (text) => {
      controller.abort();

      return speaksExactly(text, controller.signal);
    });

    const output = await reserved(subject);

    expect(await output.save(ANSWER, controller.signal)).toEqual(failure("cancelled"));
    expect(subject.files.calls.write).toBe(0);
    expect(stateOf(subject)).toBe("discarded");
  });

  it.each(["deadline first", "caller first"])(
    "lets caller cancellation win when both stop rendering (%s)",
    async (order) => {
      const controller = new AbortController();

      const subject = harness({}, async (text) => {
        if (order === "deadline first") {
          vi.advanceTimersByTime(TIMEOUT_MS);
          controller.abort();
        } else {
          controller.abort();
          vi.advanceTimersByTime(TIMEOUT_MS);
        }

        return speaksExactly(text, controller.signal);
      });

      const output = await reserved(subject);

      expect(await output.save(ANSWER, controller.signal)).toEqual(failure("cancelled"));
    },
  );

  it("is cancelled, and discards, when the caller aborts during the write before its commit", async () => {
    const controller = new AbortController();
    const subject = harness({ beforeCommit: hangingCommit });
    const output = await reserved(subject);
    const result = output.save(ANSWER, controller.signal);

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();

    expect(await result).toEqual(failure("cancelled"));
    expect(stateOf(subject)).toBe("discarded");
  });

  it("times out, and discards, when the deadline passes during the write before its commit", async () => {
    const subject = harness({ beforeCommit: hangingCommit });
    const output = await reserved(subject);
    const result = output.save(ANSWER, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(await result).toEqual(failure("synthesis_timed_out"));
    expect(stateOf(subject)).toBe("discarded");
  });

  it("succeeds when the caller aborts after the commit point: the file stays", async () => {
    const controller = new AbortController();

    const subject = harness({
      beforeCommit: async () => {
        // The port reached its commit point; from here the signal is ignored.
        controller.abort();
      },
    });

    const output = await reserved(subject);

    expect(await output.save(ANSWER, controller.signal)).toEqual(ok(undefined));
    expect(stateOf(subject)).toBe("committed");
  });

  it.each([
    ["the renderer", "tts"],
    ["the write", "write"],
  ] as const)(
    "reports %s rejecting without an abort as internal_error and discards",
    async (_name, stage) => {
      const broken = async (): Promise<never> => Promise.reject(new Error("broken"));

      const subject = stage === "tts" ? harness({}, broken) : harness({ beforeCommit: broken });

      const output = await reserved(subject);

      expect(await output.save(ANSWER, new AbortController().signal)).toEqual(
        failure("internal_error"),
      );
      expect(stateOf(subject)).toBe("discarded");
      expect(subject.logger.entries.at(-1)).toEqual({
        level: "error",
        message: "synthesis.failed",
        fields: {
          outcome: "internal_error",
          durationMs: 0,
          problem: "port_rejected_without_abort",
        },
      });
    },
  );

  it("passes one composed signal that aborts on the deadline to the renderer and the write", async () => {
    const signals: AbortSignal[] = [];

    const subject = harness(
      {
        beforeCommit: async (signal) => {
          signals.push(signal);

          return untilAborted(signal);
        },
      },
      async (text, signal) => {
        signals.push(signal);

        return speaksExactly(text, signal);
      },
    );

    const output = await reserved(subject);
    const result = output.save(ANSWER, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
    await result;

    expect(signals).toHaveLength(2);
    expect(signals[0]).toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe("speech output: privacy", () => {
  it("never logs the path, the answer, the spoken text, or the audio", async () => {
    const sentinel = "SENTINEL-9c1e";

    for (const reply of [speaksExactly, speaks(`Something ${sentinel} else.`)]) {
      const fakeFiles = createFakeAudioFiles();
      const logger = createRecordingLogger();

      const reserveOutput = createReserveSpeechOutput({
        files: fakeFiles,
        textToSpeech: createFakeTextToSpeech(reply),
        clock: createFakeClock(),
        logger,
        timeoutMs: TIMEOUT_MS,
      });

      const output = await reserveOutput(
        `C:\\Users\\${sentinel}\\answer.wav`,
        new AbortController().signal,
      );

      if (!output.ok) {
        throw new Error("reservation failed");
      }

      await output.value.save(`Your note ${sentinel} is saved.`, new AbortController().signal);

      const logged = JSON.stringify(logger.entries);

      expect(logger.entries).toHaveLength(1);
      expect(logged).not.toContain(sentinel);
      expect(logged).not.toContain("answer.wav");
    }
  });
});
