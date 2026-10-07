import { parseArgs } from "node:util";
import { err, ok, type Result } from "../domain/result.js";

export const USAGE = `Usage: voice-agent <command> [options]

Commands:
  ask --text <text>    Answer one request, calling tools when needed
  ask --audio <file>   Transcribe a WAV, MP3, MP4/M4A, or WebM file (up to 8 MiB), then answer it
  tools                List the tools the agent can call

Options:
  --speech-out <file.wav>  With ask: also save the answer as speech in a new WAV file (never
                           overwritten). The voice is AI-generated (OpenAI text-to-speech), not a
                           human voice; tell listeners so.
  -h, --help               Show this help

ask needs OPENAI_API_KEY.
`;

/** A usage problem; also the logged value, so it never contains user input. */
export type UsageProblem =
  | "invalid_arguments"
  | "unknown_command"
  | "option_not_allowed"
  | "missing_input"
  | "conflicting_input"
  | "repeated_option"
  | "blank_text"
  | "text_too_long"
  | "blank_path"
  | "speech_out_not_wav"
  | "speech_out_bad_name";

export const USAGE_REASONS = {
  invalid_arguments: undefined,
  unknown_command: undefined,
  option_not_allowed: "--text, --audio, and --speech-out are only valid with ask",
  missing_input: 'ask needs --text "<text>" or --audio <file>',
  conflicting_input: "ask takes --text or --audio, not both",
  repeated_option: "--text, --audio, and --speech-out may each be given once",
  blank_text: "--text must not be blank",
  text_too_long: "--text is longer than MAX_INPUT_TEXT_CHARS",
  blank_path: "--audio and --speech-out need a file path",
  speech_out_not_wav: "--speech-out must name a .wav file",
  speech_out_bad_name: "--speech-out file name must not contain ':'",
} satisfies { readonly [Problem in UsageProblem]: string | undefined };

/** Where the request comes from: typed text, or an audio file to transcribe. */
export type AskInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "audio"; readonly path: string };

export interface AskCommand {
  readonly kind: "ask";
  readonly input: AskInput;
  /** The WAV file to create with the spoken answer, or `null` for text only. */
  readonly speechOut: string | null;
}

export type Command =
  | { readonly kind: "help" }
  | { readonly kind: "tools" }
  | AskCommand
  | { readonly kind: "usage"; readonly problem: UsageProblem; readonly command: string | null };

const COMMANDS = new Set(["ask", "tools"]);

const ASK_OPTIONS = ["text", "audio", "speech-out"] as const;

type AskOption = (typeof ASK_OPTIONS)[number];

type Values = Partial<Record<AskOption, string>>;

type OptionToken = Extract<
  NonNullable<ReturnType<typeof parseArgsWithTokens>["tokens"]>[number],
  { kind: "option" }
>;

function parseArgsWithTokens(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    tokens: true,
    options: {
      help: { type: "boolean", short: "h" },
      text: { type: "string" },
      audio: { type: "string" },
      "speech-out": { type: "string" },
    },
  });
}

/** A path option's problem: blank, or `-` (no standard-stream mode exists). */
function pathProblem(path: string): UsageProblem | undefined {
  return path.trim() === "" || path === "-" ? "blank_path" : undefined;
}

/**
 * `--speech-out` names a new WAV file. The last path segment must end in `.wav` and contain no
 * `:` (on Windows that names an alternate data stream of another file).
 */
function speechOutProblem(path: string): UsageProblem | undefined {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);

  if (pathProblem(path) !== undefined) {
    return "blank_path";
  }

  if (!name.toLowerCase().endsWith(".wav")) {
    return "speech_out_not_wav";
  }

  return name.includes(":") ? "speech_out_bad_name" : undefined;
}

function textProblem(text: string, maxChars: number): UsageProblem | undefined {
  if (text.trim() === "") {
    return "blank_text";
  }

  return text.length > maxChars ? "text_too_long" : undefined;
}

/** Exactly one input: typed text within the limit, or an audio file path. */
function parseInput(values: Values, maxChars: number): Result<AskInput, UsageProblem> {
  const { text, audio } = values;

  if (text !== undefined && audio !== undefined) {
    return err("conflicting_input");
  }

  if (text !== undefined) {
    const problem = textProblem(text, maxChars);

    return problem === undefined ? ok({ kind: "text", text }) : err(problem);
  }

  if (audio === undefined) {
    return err("missing_input");
  }

  const problem = pathProblem(audio);

  return problem === undefined ? ok({ kind: "audio", path: audio }) : err(problem);
}

function usage(problem: UsageProblem, command: string | null): Command {
  return { kind: "usage", problem, command };
}

function parseAsk(values: Values, maxChars: number): Command {
  const input = parseInput(values, maxChars);

  if (!input.ok) {
    return usage(input.error, "ask");
  }

  const speechOut = values["speech-out"] ?? null;
  const problem = speechOut === null ? undefined : speechOutProblem(speechOut);

  return problem === undefined
    ? { kind: "ask", input: input.value, speechOut }
    : usage(problem, "ask");
}

/** Validates arguments before any application or provider work starts. */
export function parseCommand(argv: readonly string[], maxInputTextChars: number): Command {
  let parsed: ReturnType<typeof parseArgsWithTokens>;

  try {
    parsed = parseArgsWithTokens(argv);
  } catch {
    return usage("invalid_arguments", null);
  }

  const { values, positionals, tokens } = parsed;
  const name = positionals[0];
  const command = name !== undefined && COMMANDS.has(name) ? name : null;

  if (values.help === true) {
    return { kind: "help" };
  }

  if (command === null || positionals.length !== 1) {
    return usage("unknown_command", command);
  }

  const askOptions = tokens.filter(
    (token): token is OptionToken =>
      token.kind === "option" && ASK_OPTIONS.some((option) => option === token.name),
  );

  if (command === "tools") {
    return askOptions.length > 0 ? usage("option_not_allowed", command) : { kind: "tools" };
  }

  const names = askOptions.map((token) => token.name);

  if (new Set(names).size !== names.length) {
    return usage("repeated_option", command);
  }

  return parseAsk(values, maxInputTextChars);
}
