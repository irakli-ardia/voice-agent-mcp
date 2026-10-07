import { type Composition, productionComposition } from "../bootstrap/composition.js";
import type { Application } from "../bootstrap/create-application.js";
import { loadConfig } from "../config/config.js";
import { loadOpenAiCredentials, type OpenAiCredentials } from "../config/openai-credentials.js";
import type { Result } from "../domain/result.js";
import type { SpeechError, SpeechErrorCode } from "../domain/speech-error.js";
import type { TurnError, TurnErrorCode } from "../domain/turn-error.js";
import { type AskCommand, parseCommand, USAGE, USAGE_REASONS } from "./cli-arguments.js";

export const EXIT_OK = 0;

/** Every typed failure without a more specific code below. */
export const EXIT_FAILURE = 1;

/** Command-line usage, and input the user can correct before any provider is used. */
export const EXIT_USAGE = 64;

export const EXIT_UNAVAILABLE = 69;

export const EXIT_SOFTWARE = 70;

export const EXIT_TEMPFAIL = 75;

export const EXIT_CONFIG = 78;

/** 128 + SIGINT, as shells report an interrupted command. */
export const EXIT_INTERRUPTED = 130;

const EXIT_CODES = {
  cancelled: EXIT_INTERRUPTED,
  internal_error: EXIT_SOFTWARE,
  turn_timed_out: EXIT_TEMPFAIL,
  model_unavailable: EXIT_UNAVAILABLE,
  iteration_limit_exceeded: EXIT_FAILURE,
  tool_call_limit_exceeded: EXIT_FAILURE,
  model_rejected: EXIT_FAILURE,
  context_too_large: EXIT_FAILURE,
  model_incomplete: EXIT_FAILURE,
  model_refused: EXIT_FAILURE,
  model_protocol_error: EXIT_FAILURE,
  audio_unreadable: EXIT_USAGE,
  audio_too_large: EXIT_USAGE,
  audio_unsupported: EXIT_USAGE,
  speech_output_exists: EXIT_USAGE,
  transcription_timed_out: EXIT_TEMPFAIL,
  synthesis_timed_out: EXIT_TEMPFAIL,
  transcription_unavailable: EXIT_UNAVAILABLE,
  synthesis_unavailable: EXIT_UNAVAILABLE,
  transcription_empty: EXIT_FAILURE,
  transcription_too_long: EXIT_FAILURE,
  transcription_rejected: EXIT_FAILURE,
  transcription_protocol_error: EXIT_FAILURE,
  synthesis_text_too_long: EXIT_FAILURE,
  synthesis_rejected: EXIT_FAILURE,
  synthesis_incomplete: EXIT_FAILURE,
  synthesis_unfaithful: EXIT_FAILURE,
  synthesis_protocol_error: EXIT_FAILURE,
  speech_output_failed: EXIT_FAILURE,
} satisfies { readonly [Code in TurnErrorCode | SpeechErrorCode]: number };

/** Process I/O handed in by the bin, so the CLI runs in tests without touching the process. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Omitted in production: config then reads the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Aborted by the bin on the first SIGINT. */
  readonly signal: AbortSignal;
}

/** One line per tool, in registry order: name, risk, and description. */
function formatTools(tools: Application["tools"]): string {
  return tools.tools.map((tool) => `${tool.name}  ${tool.risk}  ${tool.description}\n`).join("");
}

/** The answer as written, with exactly one terminal newline: one trailing line break is replaced. */
function terminalLine(answer: string): string {
  return `${answer.replace(/\r?\n$/, "")}\n`;
}

/** Reports a typed failure: one safe line on stderr, the mapped exit code. */
function failed(io: CliIo, error: TurnError | SpeechError): number {
  io.stderr(`error: ${error.code}: ${error.message}\n`);

  return EXIT_CODES[error.code];
}

/** Saves the final answer as speech into the reserved file. */
type SaveSpeech = (answer: string, signal: AbortSignal) => Promise<Result<void, SpeechError>>;

/** Everything one `ask` uses, composed only for the parts the command asked for. */
interface AskContext {
  readonly command: AskCommand;
  readonly application: Application;
  readonly io: CliIo;
  readonly composition: Composition;
  readonly credentials: OpenAiCredentials;
}

/** The request text: as typed, or transcribed from the audio file. */
async function requestText(context: AskContext): Promise<Result<string, SpeechError>> {
  const { command, application, io, composition, credentials } = context;

  if (command.input.kind === "text") {
    return { ok: true, value: command.input.text };
  }

  const transcribe = composition.createTranscriber(application, credentials);

  return transcribe(command.input.path, io.signal);
}

/**
 * Text (or transcription) → agent turn → answer on stdout → optional speech. Once the answer is on
 * stdout it stays there: a later speech failure adds one error line on stderr and a non-zero exit.
 */
async function answer(context: AskContext, save: SaveSpeech | null): Promise<number> {
  const { application, io, composition, credentials } = context;
  const text = await requestText(context);

  if (!text.ok) {
    return failed(io, text.error);
  }

  const runTurn = composition.createAgent(application, credentials);
  const turn = await runTurn(text.value, io.signal);

  if (!turn.ok) {
    return failed(io, turn.error);
  }

  io.stdout(terminalLine(turn.value));

  if (save === null) {
    return EXIT_OK;
  }

  const saved = await save(turn.value, io.signal);

  return saved.ok ? EXIT_OK : failed(io, saved.error);
}

/** Reserves the speech file first, before any provider is used, and always releases it. */
async function runAsk(context: Omit<AskContext, "credentials">): Promise<number> {
  const { command, application, io, composition } = context;
  const credentials = loadOpenAiCredentials(io.env);

  if (!credentials.ok) {
    io.stderr(`Invalid configuration:\n  ${credentials.issues.join("\n  ")}\n`);

    return EXIT_CONFIG;
  }

  const full: AskContext = { ...context, credentials: credentials.credentials };

  if (command.speechOut === null) {
    return answer(full, null);
  }

  const reserve = composition.createSpeechOutput(application, credentials.credentials);
  const reserved = await reserve(command.speechOut, io.signal);

  if (!reserved.ok) {
    return failed(io, reserved.error);
  }

  const output = reserved.value;

  try {
    return await answer(full, async (text, signal) => output.save(text, signal));
  } finally {
    // Removes the reserved file unless the answer was saved into it.
    await output.discard();
  }
}

/** Parses arguments, wires what the command needs, and resolves to the process exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  composition: Composition = productionComposition,
): Promise<number> {
  const configResult = loadConfig(io.env);

  if (!configResult.ok) {
    io.stderr(`Invalid configuration:\n  ${configResult.issues.join("\n  ")}\n`);

    return EXIT_CONFIG;
  }

  const application = composition.createApplication(configResult.config);
  const command = parseCommand(argv, configResult.config.agent.maxInputTextChars);

  switch (command.kind) {
    case "help":
      io.stdout(USAGE);

      return EXIT_OK;
    case "tools":
      io.stdout(formatTools(application.tools));

      return EXIT_OK;
    case "ask":
      return runAsk({ command, application, io, composition });
    case "usage": {
      const reason = USAGE_REASONS[command.problem];

      application.logger.warn("cli.usage_error", {
        problem: command.problem,
        command: command.command,
      });
      io.stderr(reason === undefined ? USAGE : `error: usage: ${reason}\n\n${USAGE}`);

      return EXIT_USAGE;
    }
  }
}
