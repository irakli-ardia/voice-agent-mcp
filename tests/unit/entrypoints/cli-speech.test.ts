import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunner } from "../../../src/app/agent/agent-runner.js";
import { createReserveSpeechOutput } from "../../../src/app/audio/speech-output.js";
import { createTranscribeAudio } from "../../../src/app/audio/transcribe-audio.js";
import type { Composition } from "../../../src/bootstrap/composition.js";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import { err } from "../../../src/domain/result.js";
import {
  type CliIo,
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_TEMPFAIL,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  runCli,
} from "../../../src/entrypoints/cli.js";
import type { Logger } from "../../../src/ports/logger.js";
import { wavFile } from "../../helpers/audio-bytes.js";
import {
  createFakeAgentModel,
  type FakeAgentModel,
  type FakeReply,
  fail,
  hangUntilAbort,
  step,
} from "../../helpers/fake-agent-model.js";
import {
  createFakeAudioFiles,
  type FakeAudioFiles,
  type FakeAudioFilesOptions,
} from "../../helpers/fake-audio-files.js";
import { createFakeClock } from "../../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../../helpers/fake-id-generator.js";
import {
  createFakeSpeechToText,
  type FakeSpeechToText,
  type FakeTranscriptionReply,
  transcribesAs,
} from "../../helpers/fake-speech-to-text.js";
import {
  createFakeTextToSpeech,
  FAKE_WAV,
  type FakeSpeechReply,
  type FakeTextToSpeech,
  speaks,
  speaksExactly,
} from "../../helpers/fake-text-to-speech.js";
import { createRecordingLogger, type RecordingLogger } from "../../helpers/recording-logger.js";
import { untilAborted } from "../../helpers/until-aborted.js";

const API_KEY = "sk-test-key-SECRET";

const ENV = { LOG_LEVEL: "silent", OPENAI_API_KEY: API_KEY };

const INPUT = "question.wav";

const OUTPUT = "answer.wav";

const ANSWER = "It is 3 PM.";

interface SpeechOptions {
  readonly replies?: readonly FakeReply[];
  readonly stt?: FakeTranscriptionReply;
  readonly tts?: FakeSpeechReply;
  readonly files?: FakeAudioFilesOptions;
  readonly logger?: RecordingLogger;
}

/** The real speech services and agent runner over fakes, recording the order stages ran in. */
interface SpeechHarness {
  readonly composition: Composition;
  readonly files: FakeAudioFiles;
  readonly stt: FakeSpeechToText;
  readonly tts: FakeTextToSpeech;
  readonly model: FakeAgentModel;
  readonly events: string[];
  readonly created: { agents: number; transcribers: number; outputs: number };
}

function harness(options: SpeechOptions = {}): SpeechHarness {
  const events: string[] = [];
  const created = { agents: 0, transcribers: 0, outputs: 0 };
  const sttReply = options.stt ?? transcribesAs("What time is it?");
  const ttsReply = options.tts ?? speaksExactly;

  const files = createFakeAudioFiles({
    files: new Map([[INPUT, wavFile()]]),
    ...options.files,
    beforeReserve: async (signal) => {
      events.push("reserve");
      await options.files?.beforeReserve?.(signal);
    },
  });

  const stt = createFakeSpeechToText(async (audio, signal) => {
    events.push("stt");

    return sttReply(audio, signal);
  });

  const tts = createFakeTextToSpeech(async (text, signal) => {
    events.push("tts");

    return ttsReply(text, signal);
  });

  const model = createFakeAgentModel(
    (options.replies ?? [step(ANSWER)]).map(
      (reply): FakeReply =>
        async (...args) => {
          events.push("agent");

          return reply(...args);
        },
    ),
  );

  const logger = (base: Logger): Logger => options.logger ?? base;

  const composition: Composition = {
    createApplication: (config) => {
      const application = createApplication(config);

      return { ...application, logger: logger(application.logger) };
    },
    createAgent: (application) => {
      created.agents += 1;

      return createAgentRunner({
        model,
        registry: application.tools,
        executeTool: application.executeTool,
        ids: createFakeIdGenerator(),
        clock: createFakeClock(),
        logger: application.logger,
        limits: application.config.agent,
      });
    },
    createTranscriber: (application) => {
      created.transcribers += 1;

      return createTranscribeAudio({
        files,
        speechToText: stt,
        clock: createFakeClock(),
        logger: application.logger,
        limits: {
          maxTranscriptionChars: application.config.agent.maxInputTextChars,
          timeoutMs: application.config.speech.timeoutMs,
        },
      });
    },
    createSpeechOutput: (application) => {
      created.outputs += 1;

      return createReserveSpeechOutput({
        files,
        textToSpeech: tts,
        clock: createFakeClock(),
        logger: application.logger,
        timeoutMs: application.config.speech.timeoutMs,
      });
    },
  };

  return { composition, files, stt, tts, model, events, created };
}

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  h: SpeechHarness,
  argv: readonly string[],
  env: Readonly<Record<string, string>> = ENV,
  signal: AbortSignal = new AbortController().signal,
): Promise<Run> {
  const out: string[] = [];
  const errors: string[] = [];

  const io: CliIo = {
    env,
    signal,
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      errors.push(text);
    },
  };

  const code = await runCli(argv, io, h.composition);

  return { code, stdout: out.join(""), stderr: errors.join("") };
}

function outputState(h: SpeechHarness): string | undefined {
  return h.files.reservations.get(OUTPUT)?.state;
}

const AUDIO_ASK = ["ask", "--audio", INPUT];

const SPOKEN_ASK = ["ask", "--text", "What time is it?", "--speech-out", OUTPUT];

const FULL_ASK = ["ask", "--audio", INPUT, "--speech-out", OUTPUT];

afterEach(() => {
  vi.useRealTimers();
});

describe("ask: the four flows", () => {
  it("text only: the answer, with no speech composed or used", async () => {
    const h = harness();

    expect(await run(h, ["ask", "--text", "What time is it?"])).toEqual({
      code: EXIT_OK,
      stdout: `${ANSWER}\n`,
      stderr: "",
    });
    expect(h.created).toEqual({ agents: 1, transcribers: 0, outputs: 0 });
    expect(h.events).toEqual(["agent"]);
    expect(h.files.calls).toEqual({ read: 0, reserve: 0, write: 0, discard: 0 });
  });

  it("audio in: transcribes once, then answers the transcription", async () => {
    const h = harness({ stt: transcribesAs("Transcribed request?") });

    expect(await run(h, AUDIO_ASK)).toEqual({ code: EXIT_OK, stdout: `${ANSWER}\n`, stderr: "" });
    expect(h.events).toEqual(["stt", "agent"]);
    expect(h.stt.calls).toEqual([{ bytes: wavFile(), format: "wav" }]);
    expect(h.model.requests[0]?.transcript[0]).toEqual({
      kind: "user_text",
      text: "Transcribed request?",
    });
    expect(h.created).toEqual({ agents: 1, transcribers: 1, outputs: 0 });
  });

  it("text in, speech out: reserves first, answers, then speaks exactly the answer", async () => {
    const h = harness();

    expect(await run(h, SPOKEN_ASK)).toEqual({ code: EXIT_OK, stdout: `${ANSWER}\n`, stderr: "" });
    expect(h.events).toEqual(["reserve", "agent", "tts"]);
    expect(h.tts.calls).toEqual([ANSWER]);
    expect(h.files.reservations.get(OUTPUT)).toEqual({ state: "committed", bytes: FAKE_WAV });
    expect(h.created).toEqual({ agents: 1, transcribers: 0, outputs: 1 });
  });

  it("audio in, speech out: reserve, transcribe, answer, speak — in that order", async () => {
    const h = harness();

    expect(await run(h, FULL_ASK)).toEqual({ code: EXIT_OK, stdout: `${ANSWER}\n`, stderr: "" });
    expect(h.events).toEqual(["reserve", "stt", "agent", "tts"]);
    expect(outputState(h)).toBe("committed");
  });

  it("prints the answer once with exactly one terminal newline", async () => {
    const h = harness({ replies: [step("Line one.\nLine two.\n")] });

    expect((await run(h, SPOKEN_ASK)).stdout).toBe("Line one.\nLine two.\n");
    expect(h.tts.calls).toEqual(["Line one.\nLine two.\n"]);
  });

  it("asks for the key before composing any speech", async () => {
    const h = harness();

    expect((await run(h, FULL_ASK, { LOG_LEVEL: "silent" })).code).toBe(EXIT_CONFIG);
    expect(h.created).toEqual({ agents: 0, transcribers: 0, outputs: 0 });
  });
});

describe("ask: failures before the answer keep stdout empty", () => {
  it.each([
    ["a missing audio file", { files: new Map() }, "audio_unreadable", EXIT_USAGE],
    [
      "a file that is not audio",
      { files: new Map([[INPUT, new TextEncoder().encode("SECRET text")]]) },
      "audio_unsupported",
      EXIT_USAGE,
    ],
    ["an oversized file", { read: async () => err("too_large") }, "audio_too_large", EXIT_USAGE],
  ] as const)("refuses %s without transcribing or answering", async (_name, files, code, exit) => {
    const h = harness({ files });
    const result = await run(h, AUDIO_ASK);

    expect(result).toEqual({
      code: exit,
      stdout: "",
      stderr: expect.stringMatching(new RegExp(`^error: ${code}: [^\\n]+\\n$`)),
    });
    expect(h.events).toEqual([]);
  });

  it.each([
    ["unavailable", "transcription_unavailable", EXIT_UNAVAILABLE],
    ["rejected", "transcription_rejected", EXIT_FAILURE],
    ["protocol_error", "transcription_protocol_error", EXIT_FAILURE],
  ] as const)(
    "stops after a %s transcription, releasing the reserved file",
    async (failure, code, exit) => {
      const h = harness({ stt: async () => err({ code: failure }) });
      const result = await run(h, FULL_ASK);

      expect(result.code).toBe(exit);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(new RegExp(`^error: ${code}: `));
      expect(h.events).toEqual(["reserve", "stt"]);
      expect(outputState(h)).toBe("discarded");
    },
  );

  it("stops after a blank transcription", async () => {
    const h = harness({ stt: transcribesAs("  ") });

    expect(await run(h, AUDIO_ASK)).toMatchObject({ code: EXIT_FAILURE, stdout: "" });
    expect(h.events).toEqual(["stt"]);
  });

  it("refuses an existing output file before transcribing, answering, or speaking", async () => {
    const h = harness({
      files: {
        files: new Map([
          [INPUT, wavFile()],
          [OUTPUT, wavFile()],
        ]),
      },
    });

    const result = await run(h, FULL_ASK);

    expect(result).toEqual({
      code: EXIT_USAGE,
      stdout: "",
      stderr: "error: speech_output_exists: The speech output file already exists.\n",
    });
    expect(h.events).toEqual(["reserve"]);
  });

  it("refuses an output file it cannot create (such as a missing folder) before any spend", async () => {
    const h = harness({ files: { reserveFails: true } });

    expect(await run(h, SPOKEN_ASK)).toMatchObject({ code: EXIT_FAILURE, stdout: "" });
    expect(h.events).toEqual(["reserve"]);
  });

  it("releases the reserved file when the agent fails, and never speaks", async () => {
    const h = harness({ replies: [fail("unavailable")] });
    const result = await run(h, SPOKEN_ASK);

    expect(result).toMatchObject({ code: EXIT_UNAVAILABLE, stdout: "" });
    expect(h.tts.calls).toEqual([]);
    expect(outputState(h)).toBe("discarded");
  });
});

describe("ask: a speech failure after the answer keeps the answer (D1)", () => {
  it.each([
    ["unavailable", "synthesis_unavailable", EXIT_UNAVAILABLE],
    ["rejected", "synthesis_rejected", EXIT_FAILURE],
    ["incomplete", "synthesis_incomplete", EXIT_FAILURE],
    ["protocol_error", "synthesis_protocol_error", EXIT_FAILURE],
  ] as const)("keeps the answer on stdout when rendering is %s", async (failure, code, exit) => {
    const h = harness({ tts: async () => err({ code: failure }) });
    const result = await run(h, SPOKEN_ASK);

    expect(result.code).toBe(exit);
    expect(result.stdout).toBe(`${ANSWER}\n`);
    expect(result.stderr).toMatch(new RegExp(`^error: ${code}: [^\\n]+\\n$`));
    expect(outputState(h)).toBe("discarded");
  });

  it("keeps the answer but saves nothing when the spoken text differs from the answer", async () => {
    const h = harness({ tts: speaks("It is three PM.") });

    expect(await run(h, SPOKEN_ASK)).toEqual({
      code: EXIT_FAILURE,
      stdout: `${ANSWER}\n`,
      stderr:
        "error: synthesis_unfaithful: The generated speech did not match the answer, so it was not saved.\n",
    });
    expect(h.files.calls.write).toBe(0);
    expect(outputState(h)).toBe("discarded");
  });

  it("keeps the answer but does not speak an answer longer than 800 characters", async () => {
    const long = "x".repeat(801);
    const h = harness({ replies: [step(long)] });
    const result = await run(h, SPOKEN_ASK);

    expect(result).toMatchObject({ code: EXIT_FAILURE, stdout: `${long}\n` });
    expect(result.stderr).toMatch(/^error: synthesis_text_too_long: /);
    expect(h.tts.calls).toEqual([]);
  });

  it("keeps the answer when writing the WAV fails", async () => {
    const h = harness({ files: { writeFails: true } });
    const result = await run(h, SPOKEN_ASK);

    expect(result).toMatchObject({ code: EXIT_FAILURE, stdout: `${ANSWER}\n` });
    expect(result.stderr).toMatch(/^error: speech_output_failed: /);
    expect(outputState(h)).toBe("discarded");
  });

  it("keeps the answer and exits 75 when the speech deadline passes", async () => {
    vi.useFakeTimers();

    const h = harness({ tts: async (_text, signal) => untilAborted(signal) });
    const pending = run(h, SPOKEN_ASK, { ...ENV, SPEECH_TIMEOUT_MS: "5000" });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toEqual({
      code: EXIT_TEMPFAIL,
      stdout: `${ANSWER}\n`,
      stderr:
        "error: synthesis_timed_out: Speech generation did not finish within its time limit.\n",
    });
    expect(outputState(h)).toBe("discarded");
  });

  it("exits 75 when the speech deadline passes during transcription, before any answer", async () => {
    vi.useFakeTimers();

    const h = harness({ stt: async (_audio, signal) => untilAborted(signal) });
    const pending = run(h, AUDIO_ASK, { ...ENV, SPEECH_TIMEOUT_MS: "5000" });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toMatchObject({ code: EXIT_TEMPFAIL, stdout: "" });
  });
});

describe("ask: cancellation (first SIGINT aborts the signal)", () => {
  async function cancelDuring(h: SpeechHarness, argv: readonly string[]): Promise<Run> {
    const controller = new AbortController();
    const pending = run(h, argv, ENV, controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    return pending;
  }

  const cancelled = "error: cancelled: The request was cancelled.\n";

  it("during the reservation: exits 130 with nothing reserved", async () => {
    const h = harness({ files: { beforeReserve: async (signal) => untilAborted(signal) } });

    expect(await cancelDuring(h, FULL_ASK)).toEqual({
      code: EXIT_INTERRUPTED,
      stdout: "",
      stderr: cancelled,
    });
    expect(h.files.reservations.size).toBe(0);
  });

  it("during transcription: exits 130, never answers, releases the file", async () => {
    const h = harness({ stt: async (_audio, signal) => untilAborted(signal) });

    expect(await cancelDuring(h, FULL_ASK)).toEqual({
      code: EXIT_INTERRUPTED,
      stdout: "",
      stderr: cancelled,
    });
    expect(h.model.requests).toHaveLength(0);
    expect(outputState(h)).toBe("discarded");
  });

  it("during the agent turn: exits 130 with empty stdout, never speaks", async () => {
    const h = harness({ replies: [hangUntilAbort] });

    expect(await cancelDuring(h, SPOKEN_ASK)).toEqual({
      code: EXIT_INTERRUPTED,
      stdout: "",
      stderr: cancelled,
    });
    expect(h.tts.calls).toEqual([]);
    expect(outputState(h)).toBe("discarded");
  });

  it("during speech: keeps the printed answer, exits 130, commits nothing", async () => {
    const h = harness({ tts: async (_text, signal) => untilAborted(signal) });

    expect(await cancelDuring(h, SPOKEN_ASK)).toEqual({
      code: EXIT_INTERRUPTED,
      stdout: `${ANSWER}\n`,
      stderr: cancelled,
    });
    expect(outputState(h)).toBe("discarded");
  });

  it("during the write before its commit: exits 130 and removes the file", async () => {
    const h = harness({ files: { beforeCommit: async (signal) => untilAborted(signal) } });

    expect(await cancelDuring(h, SPOKEN_ASK)).toEqual({
      code: EXIT_INTERRUPTED,
      stdout: `${ANSWER}\n`,
      stderr: cancelled,
    });
    expect(outputState(h)).toBe("discarded");
  });

  it("after the commit point: the saved file stands and the command succeeds", async () => {
    const controller = new AbortController();

    const h = harness({
      files: {
        beforeCommit: async () => {
          controller.abort();
        },
      },
    });

    expect(await run(h, SPOKEN_ASK, ENV, controller.signal)).toEqual({
      code: EXIT_OK,
      stdout: `${ANSWER}\n`,
      stderr: "",
    });
    expect(outputState(h)).toBe("committed");
  });
});

describe("ask: privacy", () => {
  it("never logs or reports paths, the transcription, the answer, the spoken text, audio, or the key", async () => {
    const logger = createRecordingLogger();
    const secretInput = "C:\\Users\\INPUT-PATH-SECRET\\q.wav";
    const secretOutput = "C:\\Users\\OUTPUT-PATH-SECRET\\a.wav";

    for (const tts of [speaksExactly, speaks("SPOKEN-TEXT-SECRET")]) {
      const h = harness({
        logger,
        files: { files: new Map([[secretInput, wavFile()]]) },
        stt: transcribesAs("TRANSCRIPTION-SECRET"),
        replies: [step("ANSWER-SECRET")],
        tts,
      });

      const result = await run(h, ["ask", "--audio", secretInput, "--speech-out", secretOutput]);

      expect(JSON.stringify(result.stderr)).not.toMatch(/SECRET/);
    }

    const logged = JSON.stringify(logger.entries);

    for (const secret of [
      "PATH-SECRET",
      "TRANSCRIPTION-SECRET",
      "ANSWER-SECRET",
      "SPOKEN-TEXT-SECRET",
      API_KEY,
      "RIFF",
    ]) {
      expect(logged).not.toContain(secret);
    }

    expect(logger.entries.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        "transcription.completed",
        "synthesis.completed",
        "synthesis.failed",
      ]),
    );
  });
});
