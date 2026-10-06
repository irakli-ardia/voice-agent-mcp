import { parseArgs } from "node:util";
import { type Composition, productionComposition } from "../bootstrap/composition.js";
import type { Application } from "../bootstrap/create-application.js";
import { loadConfig } from "../config/config.js";
import { loadOpenAiCredentials } from "../config/openai-credentials.js";
import type { TurnErrorCode } from "../domain/turn-error.js";

export const EXIT_OK = 0;

/** Every typed turn failure without a more specific code below. */
export const EXIT_FAILURE = 1;

export const EXIT_USAGE = 64;

export const EXIT_UNAVAILABLE = 69;

export const EXIT_SOFTWARE = 70;

export const EXIT_TEMPFAIL = 75;

export const EXIT_CONFIG = 78;

/** 128 + SIGINT, as shells report an interrupted command. */
export const EXIT_INTERRUPTED = 130;

const EXIT_CODES = {
  cancelled: EXIT_INTERRUPTED,
  turn_timed_out: EXIT_TEMPFAIL,
  model_unavailable: EXIT_UNAVAILABLE,
  internal_error: EXIT_SOFTWARE,
  iteration_limit_exceeded: EXIT_FAILURE,
  tool_call_limit_exceeded: EXIT_FAILURE,
  model_rejected: EXIT_FAILURE,
  context_too_large: EXIT_FAILURE,
  model_incomplete: EXIT_FAILURE,
  model_refused: EXIT_FAILURE,
  model_protocol_error: EXIT_FAILURE,
} satisfies { readonly [Code in TurnErrorCode]: number };

const USAGE = `Usage: voice-agent <command> [options]

Commands:
  ask --text <text>   Answer one request, calling tools when needed (needs OPENAI_API_KEY)
  tools               List the tools the agent can call

Options:
  -h, --help          Show this help
`;

/** Process I/O handed in by the bin, so the CLI runs in tests without touching the process. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Omitted in production: config then reads the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Aborted by the bin on the first SIGINT. */
  readonly signal: AbortSignal;
}

/** A usage problem; also the logged value, so it never contains user input. */
type UsageProblem =
  | "invalid_arguments"
  | "unknown_command"
  | "text_not_allowed"
  | "missing_text"
  | "repeated_text"
  | "blank_text"
  | "text_too_long";

const USAGE_REASONS = {
  invalid_arguments: undefined,
  unknown_command: undefined,
  text_not_allowed: "--text is only valid with ask",
  missing_text: 'ask needs --text "<text>"',
  repeated_text: "--text may be given once",
  blank_text: "--text must not be blank",
  text_too_long: "--text is longer than MAX_INPUT_TEXT_CHARS",
} satisfies { readonly [Problem in UsageProblem]: string | undefined };

type Command =
  | { readonly kind: "help" }
  | { readonly kind: "tools" }
  | { readonly kind: "ask"; readonly text: string }
  | { readonly kind: "usage"; readonly problem: UsageProblem; readonly command: string | null };

const COMMANDS = new Set(["ask", "tools"]);

function askProblem(
  text: string | undefined,
  textOptions: number,
  maxChars: number,
): UsageProblem | undefined {
  if (text === undefined) {
    return "missing_text";
  }

  if (textOptions > 1) {
    return "repeated_text";
  }

  if (text.trim() === "") {
    return "blank_text";
  }

  return text.length > maxChars ? "text_too_long" : undefined;
}

function parseAsk(text: string | undefined, textOptions: number, maxChars: number): Command {
  const problem = askProblem(text, textOptions, maxChars);

  if (problem !== undefined || text === undefined) {
    return { kind: "usage", problem: problem ?? "missing_text", command: "ask" };
  }

  return { kind: "ask", text };
}

/** Validates arguments before any application or model work starts. */
function parseCommand(argv: readonly string[], maxInputTextChars: number): Command {
  let parsed: ReturnType<typeof parseArgsWithTokens>;

  try {
    parsed = parseArgsWithTokens(argv);
  } catch {
    return { kind: "usage", problem: "invalid_arguments", command: null };
  }

  const { values, positionals, tokens } = parsed;
  const name = positionals[0];
  const command = name !== undefined && COMMANDS.has(name) ? name : null;

  if (values.help === true) {
    return { kind: "help" };
  }

  if (command === null || positionals.length !== 1) {
    return { kind: "usage", problem: "unknown_command", command };
  }

  const textOptions = tokens.filter((token) => token.kind === "option" && token.name === "text");

  if (command === "tools") {
    return textOptions.length > 0
      ? { kind: "usage", problem: "text_not_allowed", command }
      : { kind: "tools" };
  }

  return parseAsk(values.text, textOptions.length, maxInputTextChars);
}

function parseArgsWithTokens(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    tokens: true,
    options: { help: { type: "boolean", short: "h" }, text: { type: "string" } },
  });
}

/** One line per tool, in registry order: name, risk, and description. */
function formatTools(tools: Application["tools"]): string {
  return tools.tools.map((tool) => `${tool.name}  ${tool.risk}  ${tool.description}\n`).join("");
}

/** The answer as written, with exactly one terminal newline: one trailing line break is replaced. */
function terminalLine(answer: string): string {
  return `${answer.replace(/\r?\n$/, "")}\n`;
}

async function runAsk(
  text: string,
  application: Application,
  io: CliIo,
  composition: Composition,
): Promise<number> {
  const credentials = loadOpenAiCredentials(io.env);

  if (!credentials.ok) {
    io.stderr(`Invalid configuration:\n  ${credentials.issues.join("\n  ")}\n`);

    return EXIT_CONFIG;
  }

  const runTurn = composition.createAgent(application, credentials.credentials);
  const result = await runTurn(text, io.signal);

  if (result.ok) {
    io.stdout(terminalLine(result.value));

    return EXIT_OK;
  }

  io.stderr(`error: ${result.error.code}: ${result.error.message}\n`);

  return EXIT_CODES[result.error.code];
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
      return runAsk(command.text, application, io, composition);
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
