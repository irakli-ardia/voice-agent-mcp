import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalAudioFiles } from "../../src/adapters/persistence/local-audio-files.js";
import { createAgentRunner } from "../../src/app/agent/agent-runner.js";
import { createReserveSpeechOutput } from "../../src/app/audio/speech-output.js";
import { createTranscribeAudio } from "../../src/app/audio/transcribe-audio.js";
import type { Composition } from "../../src/bootstrap/composition.js";
import { createApplication } from "../../src/bootstrap/create-application.js";
import { err } from "../../src/domain/result.js";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, runCli } from "../../src/entrypoints/cli.js";
import type { TextToSpeech } from "../../src/ports/text-to-speech.js";
import { wavFile } from "../helpers/audio-bytes.js";
import { createFakeAgentModel, step } from "../helpers/fake-agent-model.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../helpers/fake-id-generator.js";
import { createFakeSpeechToText, transcribesAs } from "../helpers/fake-speech-to-text.js";
import {
  createFakeTextToSpeech,
  FAKE_WAV,
  speaks,
  speaksExactly,
} from "../helpers/fake-text-to-speech.js";

/**
 * `ask --audio … --speech-out …` end to end with the real CLI, real speech services, and the real
 * local audio files adapter in a temporary directory; only the providers (model, STT, TTS) are fakes.
 */
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "voice-ask-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function composition(
  textToSpeech: TextToSpeech = createFakeTextToSpeech(speaksExactly),
): Composition {
  return {
    createApplication,
    createAgent: (application) =>
      createAgentRunner({
        model: createFakeAgentModel([step("It is 3 PM.")]),
        registry: application.tools,
        executeTool: application.executeTool,
        ids: createFakeIdGenerator(),
        clock: createFakeClock(),
        logger: application.logger,
        limits: application.config.agent,
      }),
    createTranscriber: (application) =>
      createTranscribeAudio({
        files: createLocalAudioFiles({ logger: application.logger }),
        speechToText: createFakeSpeechToText(transcribesAs("What time is it?")),
        clock: createFakeClock(),
        logger: application.logger,
        limits: { maxTranscriptionChars: 4_000, timeoutMs: 5_000 },
      }),
    createSpeechOutput: (application) =>
      createReserveSpeechOutput({
        files: createLocalAudioFiles({ logger: application.logger }),
        textToSpeech,
        clock: createFakeClock(),
        logger: application.logger,
        timeoutMs: 5_000,
      }),
  };
}

async function ask(
  argv: readonly string[],
  tts?: TextToSpeech,
): Promise<{ code: number; stdout: string }> {
  const out: string[] = [];

  const code = await runCli(
    argv,
    {
      env: { LOG_LEVEL: "silent", OPENAI_API_KEY: "sk-test", DATA_DIR: join(root, "data") },
      signal: new AbortController().signal,
      stdout: (text) => {
        out.push(text);
      },
      stderr: () => undefined,
    },
    composition(tts),
  );

  return { code, stdout: out.join("") };
}

describe("voice ask on the real filesystem", () => {
  it("reads the audio, answers, and commits exactly the rendered WAV", async () => {
    const input = join(root, "question.wav");
    const output = join(root, "answer.wav");

    await writeFile(input, wavFile());

    expect(await ask(["ask", "--audio", input, "--speech-out", output])).toEqual({
      code: EXIT_OK,
      stdout: "It is 3 PM.\n",
    });
    expect(new Uint8Array(await readFile(output))).toEqual(FAKE_WAV);
  });

  it("never overwrites an existing output file", async () => {
    const output = join(root, "answer.wav");

    await writeFile(output, "keep me");

    expect((await ask(["ask", "--text", "Hi", "--speech-out", output])).code).toBe(EXIT_USAGE);
    expect(await readFile(output, "utf8")).toBe("keep me");
  });

  it("fails for a missing parent directory and creates no directory", async () => {
    const output = join(root, "missing", "answer.wav");

    expect(await ask(["ask", "--text", "Hi", "--speech-out", output])).toEqual({
      code: EXIT_FAILURE,
      stdout: "",
    });
    expect(await readdir(root)).toEqual([]);
  });

  it.each([
    ["an unfaithful rendering", createFakeTextToSpeech(speaks("Something else."))],
    ["a failed rendering", createFakeTextToSpeech(async () => err({ code: "unavailable" }))],
  ])("leaves no file behind after %s, keeping the answer on stdout", async (_name, tts) => {
    const output = join(root, "answer.wav");

    const result = await ask(["ask", "--text", "Hi", "--speech-out", output], tts);

    expect(result.code).not.toBe(EXIT_OK);
    expect(result.stdout).toBe("It is 3 PM.\n");
    expect(await readdir(root)).toEqual([]);
  });

  it("never sends a non-audio file to speech-to-text", async () => {
    const input = join(root, "notes.wav");

    await writeFile(input, "OPENAI_API_KEY=sk-not-audio\n");

    expect(await ask(["ask", "--audio", input])).toEqual({ code: EXIT_USAGE, stdout: "" });
  });
});
