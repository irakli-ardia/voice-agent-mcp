import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunner } from "../../../src/app/agent/agent-runner.js";
import { createToolExecutor } from "../../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../../src/app/tools/tool-registry.js";
import type { Composition } from "../../../src/bootstrap/composition.js";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import {
  type CliIo,
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_SOFTWARE,
  EXIT_TEMPFAIL,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  runCli,
} from "../../../src/entrypoints/cli.js";
import { calculateTool } from "../../../src/tools/calculate/calculate-tool.js";
import { defineCreateNoteTool } from "../../../src/tools/create-note/create-note-tool.js";
import {
  createFakeAgentModel,
  type FakeReply,
  fail,
  hangUntilAbort,
  step,
  toolCall,
} from "../../helpers/fake-agent-model.js";
import { createFakeClock } from "../../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../../helpers/fake-id-generator.js";
import { createFakeNoteStore } from "../../helpers/fake-note-store.js";
import { createRecordingLogger, type RecordingLogger } from "../../helpers/recording-logger.js";

interface CapturedIo {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

type Env = Readonly<Record<string, string | undefined>>;

function captureIo(env: Env, signal: AbortSignal = new AbortController().signal): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];

  return {
    io: {
      env,
      signal,
      stdout: (text: string): void => {
        out.push(text);
      },
      stderr: (text: string): void => {
        err.push(text);
      },
    },
    stdout: (): string => out.join(""),
    stderr: (): string => err.join(""),
  };
}

const QUIET = { LOG_LEVEL: "silent" };

const API_KEY = "sk-test-key-SECRET";

const WITH_KEY = { ...QUIET, OPENAI_API_KEY: API_KEY };

interface CountingComposition extends Composition {
  readonly agentsCreated: () => number;
  /** Transcribers and speech outputs composed; a text-only ask must compose neither. */
  readonly speechCreated: () => number;
}

/** A speech factory a text-only command must never reach. */
function unexpectedSpeech(counter: { value: number }): never {
  counter.value += 1;

  throw new Error("a text-only ask composed speech");
}

/** The real application, with a scripted model behind `createAgent`: no OpenAI, no network. */
function fakeComposition(replies: readonly FakeReply[]): CountingComposition {
  let agentsCreated = 0;
  const speech = { value: 0 };

  return {
    createApplication,
    createAgent: (application) => {
      agentsCreated += 1;

      return createAgentRunner({
        model: createFakeAgentModel(replies),
        registry: application.tools,
        executeTool: application.executeTool,
        ids: createFakeIdGenerator(),
        clock: createFakeClock(),
        logger: application.logger,
        limits: application.config.agent,
      });
    },
    createTranscriber: () => unexpectedSpeech(speech),
    createSpeechOutput: () => unexpectedSpeech(speech),
    agentsCreated: () => agentsCreated,
    speechCreated: () => speech.value,
  };
}

interface AskResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function ask(
  replies: readonly FakeReply[],
  argv: readonly string[] = ["ask", "--text", "Hello?"],
  env: Env = WITH_KEY,
): Promise<AskResult> {
  const captured = captureIo(env);
  const code = await runCli(argv, captured.io, fakeComposition(replies));

  return { code, stdout: captured.stdout(), stderr: captured.stderr() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runCli", () => {
  it("prints usage to stdout and exits 0 for --help", async () => {
    const captured = captureIo(QUIET);

    expect(await runCli(["--help"], captured.io)).toBe(EXIT_OK);
    expect(captured.stdout()).toContain("Usage: voice-agent");
    expect(captured.stderr()).toBe("");
  });

  it("exits 64 with usage on stderr for an unknown command", async () => {
    const captured = captureIo(QUIET);

    expect(await runCli(["bogus"], captured.io)).toBe(EXIT_USAGE);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("Usage: voice-agent");
  });

  it("exits 64 for an unknown option", async () => {
    const captured = captureIo(QUIET);

    expect(await runCli(["--nope"], captured.io)).toBe(EXIT_USAGE);
    expect(captured.stderr()).toContain("Usage: voice-agent");
  });

  it("exits 78 and names the variable for invalid configuration", async () => {
    const captured = captureIo({ LOG_LEVEL: "loud" });

    expect(await runCli(["--help"], captured.io)).toBe(EXIT_CONFIG);
    expect(captured.stderr()).toContain("LOG_LEVEL");
    expect(captured.stdout()).toBe("");
  });

  it("lists every tool in registry order, one line each, without an API key", async () => {
    const captured = captureIo(QUIET);

    expect(await runCli(["tools"], captured.io)).toBe(EXIT_OK);
    expect(captured.stderr()).toBe("");

    const lines = captured.stdout().split("\n");

    expect(lines.at(-1)).toBe("");
    expect(lines.slice(0, -1).map((line) => line.split("  ").slice(0, 2))).toEqual([
      ["get_current_time", "read"],
      ["calculate", "read"],
      ["create_note", "write"],
      ["read_note", "read"],
    ]);
  });

  it("shows no host-owned field specially in the tool list", async () => {
    const captured = captureIo(QUIET);

    await runCli(["tools"], captured.io);

    expect(captured.stdout()).not.toContain("idempotencyKey");
  });

  it("exits 64 for tools with an extra argument", async () => {
    const captured = captureIo(QUIET);

    expect(await runCli(["tools", "extra"], captured.io)).toBe(EXIT_USAGE);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("Usage: voice-agent");
  });

  it("keeps validating non-secret configuration before any command", async () => {
    const captured = captureIo({ AGENT_TURN_TIMEOUT_MS: "1" });

    expect(await runCli(["tools"], captured.io)).toBe(EXIT_CONFIG);
    expect(captured.stderr()).toContain("AGENT_TURN_TIMEOUT_MS");
    expect(captured.stdout()).toBe("");
  });
});

describe("runCli ask: text only composes no speech", () => {
  it("answers --text without composing a transcriber or a speech output", async () => {
    const composition = fakeComposition([step("Hi there.")]);
    const captured = captureIo(WITH_KEY);

    expect(await runCli(["ask", "--text", "Hello?"], captured.io, composition)).toBe(EXIT_OK);
    expect(captured.stdout()).toBe("Hi there.\n");
    expect(composition.speechCreated()).toBe(0);
  });
});

describe("runCli ask: success", () => {
  it("writes only the final answer and one newline to stdout", async () => {
    expect(await ask([step("The answer.")])).toEqual({
      code: EXIT_OK,
      stdout: "The answer.\n",
      stderr: "",
    });
  });

  it.each([
    ["hello", "hello\n"],
    ["hello\n", "hello\n"],
    ["hello\r\n", "hello\n"],
    ["hello\n\n", "hello\n\n"],
    ["  leading\n\ninner\ttrailing  ", "  leading\n\ninner\ttrailing  \n"],
  ])("normalises only the terminal newline of %j", async (answer, printed) => {
    expect((await ask([step(answer)])).stdout).toBe(printed);
  });

  it("runs tool calls through the real executor before answering", async () => {
    const result = await ask([
      step(null, [toolCall("c1", "calculate", { operation: "add", a: 2, b: 3 })]),
      step("5"),
    ]);

    expect(result).toEqual({ code: EXIT_OK, stdout: "5\n", stderr: "" });
  });

  it("accepts text exactly at MAX_INPUT_TEXT_CHARS", async () => {
    const result = await ask([step("Ok.")], ["ask", "--text", "12345"], {
      ...WITH_KEY,
      MAX_INPUT_TEXT_CHARS: "5",
    });

    expect(result.code).toBe(EXIT_OK);
  });
});

describe("runCli ask: failures", () => {
  it.each<[string, readonly FakeReply[], Record<string, string>, number]>([
    ["model_unavailable", [fail("unavailable")], {}, EXIT_UNAVAILABLE],
    ["model_rejected", [fail("rejected")], {}, EXIT_FAILURE],
    ["context_too_large", [fail("context_too_large")], {}, EXIT_FAILURE],
    ["model_incomplete", [fail("incomplete")], {}, EXIT_FAILURE],
    ["model_refused", [fail("refused")], {}, EXIT_FAILURE],
    ["model_protocol_error", [step(null)], {}, EXIT_FAILURE],
    [
      "iteration_limit_exceeded",
      [step(null, [toolCall("c1", "calculate", {})])],
      { MAX_AGENT_ITERATIONS: "1" },
      EXIT_FAILURE,
    ],
    [
      "tool_call_limit_exceeded",
      [step(null, [toolCall("c1", "calculate", {}), toolCall("c2", "calculate", {})])],
      { MAX_TOOL_CALLS_PER_TURN: "1" },
      EXIT_FAILURE,
    ],
    [
      "internal_error",
      [
        async () => {
          throw new Error("PROVIDER-DETAIL-SECRET");
        },
      ],
      {},
      EXIT_SOFTWARE,
    ],
  ])(
    "maps %s to its exit code with one safe error line and empty stdout",
    async (code, replies, env, exit) => {
      const result = await ask(replies, ["ask", "--text", "Hello?"], { ...WITH_KEY, ...env });

      expect(result.code).toBe(exit);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(new RegExp(`^error: ${code}: [^\\n]+\\n$`));
      expect(result.stderr).not.toContain("SECRET");
    },
  );

  it("exits 75 when the turn deadline passes", async () => {
    vi.useFakeTimers();

    const pending = ask([hangUntilAbort], ["ask", "--text", "Hello?"], {
      ...WITH_KEY,
      AGENT_TURN_TIMEOUT_MS: "5000",
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toEqual({
      code: EXIT_TEMPFAIL,
      stdout: "",
      stderr: "error: turn_timed_out: The request did not finish within its time limit.\n",
    });
  });

  it("exits 130 when the caller's signal aborts the turn", async () => {
    const controller = new AbortController();
    const captured = captureIo(WITH_KEY, controller.signal);

    const pending = runCli(
      ["ask", "--text", "Hello?"],
      captured.io,
      fakeComposition([hangUntilAbort]),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    expect(await pending).toBe(EXIT_INTERRUPTED);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toBe("error: cancelled: The request was cancelled.\n");
  });
});

describe("runCli ask: credentials and usage", () => {
  it("exits 78 naming OPENAI_API_KEY when ask has no key, and composes no agent", async () => {
    const captured = captureIo(QUIET);
    const composition = fakeComposition([step("Never.")]);

    expect(await runCli(["ask", "--text", "Hello?"], captured.io, composition)).toBe(EXIT_CONFIG);
    expect(captured.stderr()).toBe(
      "Invalid configuration:\n  OPENAI_API_KEY: is required for this command\n",
    );
    expect(captured.stdout()).toBe("");
    expect(composition.agentsCreated()).toBe(0);
  });

  it("never echoes the API key", async () => {
    const result = await ask([fail("rejected")]);

    expect(JSON.stringify(result)).not.toContain(API_KEY);
  });

  it.each<[string, readonly string[], string | null]>([
    ["no input", ["ask"], "ask needs --text"],
    ["empty text", ["ask", "--text", ""], "--text must not be blank"],
    ["blank text", ["ask", "--text", " \n\t "], "--text must not be blank"],
    [
      "repeated --text",
      ["ask", "--text", "a", "--text", "b"],
      "--text, --audio, and --speech-out may each be given once",
    ],
    ["text over the limit", ["ask", "--text", "123456"], "--text is longer than"],
    [
      "--text with tools",
      ["tools", "--text", "a"],
      "--text, --audio, and --speech-out are only valid with ask",
    ],
    ["--text without a command", ["--text", "a"], null],
    ["an extra argument", ["ask", "--text", "a", "extra"], null],
  ])("exits 64 for %s before any key check or model work", async (_case, argv, reason) => {
    const captured = captureIo({ ...QUIET, MAX_INPUT_TEXT_CHARS: "5" });
    const composition = fakeComposition([step("Never.")]);

    expect(await runCli(argv, captured.io, composition)).toBe(EXIT_USAGE);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("Usage: voice-agent");
    expect(captured.stderr().includes(`error: usage: ${reason ?? ""}`)).toBe(reason !== null);
    expect(composition.agentsCreated()).toBe(0);
  });

  it.each([["--help"], ["tools"]])("runs %s without an API key", async (command) => {
    const captured = captureIo(QUIET);

    expect(await runCli([command], captured.io, fakeComposition([]))).toBe(EXIT_OK);
  });
});

/** The application's shape with a recording logger, so the test can read every event. */
function recordingComposition(replies: readonly FakeReply[], logger: RecordingLogger): Composition {
  const clock = createFakeClock();

  return {
    createApplication: (config) => {
      const tools = createToolRegistry([
        calculateTool,
        defineCreateNoteTool(createFakeNoteStore()),
      ]);

      return {
        config,
        logger,
        tools,
        executeTool: createToolExecutor({ registry: tools, clock, logger, maxResultBytes: 16_384 }),
      };
    },
    createAgent: (application) =>
      createAgentRunner({
        model: createFakeAgentModel(replies),
        registry: application.tools,
        executeTool: application.executeTool,
        ids: createFakeIdGenerator(),
        clock,
        logger: application.logger,
        limits: application.config.agent,
      }),
    createTranscriber: () => unexpectedSpeech({ value: 0 }),
    createSpeechOutput: () => unexpectedSpeech({ value: 0 }),
  };
}

describe("runCli ask: logging", () => {
  it("logs no user text, assistant text, arguments, note text, or keys", async () => {
    const logger = createRecordingLogger();
    const captured = captureIo(WITH_KEY);

    await runCli(
      ["ask", "--text", "USER-TEXT-SECRET"],
      captured.io,
      recordingComposition(
        [
          step("INTERMEDIATE-SECRET", [
            toolCall("c1", "create_note", {
              text: "NOTE-TEXT-SECRET",
              idempotencyKey: "MODEL-KEY-SECRET-1",
            }),
          ]),
          step("FINAL-ANSWER-SECRET"),
        ],
        logger,
      ),
    );

    const logged = JSON.stringify(logger.entries);

    for (const secret of [
      "USER-TEXT-SECRET",
      "INTERMEDIATE-SECRET",
      "NOTE-TEXT-SECRET",
      "MODEL-KEY-SECRET-1",
      "FINAL-ANSWER-SECRET",
      API_KEY,
    ]) {
      expect(logged).not.toContain(secret);
    }

    expect(captured.stdout()).toBe("FINAL-ANSWER-SECRET\n");
  });

  it("logs a usage error without the user's text", async () => {
    const logger = createRecordingLogger();
    const captured = captureIo(QUIET);

    await runCli(["remember my PIN-SECRET"], captured.io, recordingComposition([], logger));

    expect(logger.entries).toEqual([
      {
        level: "warn",
        message: "cli.usage_error",
        fields: { problem: "unknown_command", command: null },
      },
    ]);
  });
});
