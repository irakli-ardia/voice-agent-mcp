import { parseArgs } from "node:util";
import { createApplication } from "../bootstrap/create-application.js";
import { loadConfig } from "../config/config.js";

export const EXIT_OK = 0;

export const EXIT_USAGE = 64;

export const EXIT_CONFIG = 78;

const USAGE = `Usage: voice-agent [--help]

No commands yet. ask, tools, mcp and doctor arrive in later milestones.
`;

/** Process I/O handed in by the bin, so the CLI runs in tests without touching the process. */
export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Omitted in production: config then reads the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

interface CliArgs {
  readonly help: boolean;
  readonly command: string | undefined;
}

function parseCliArgs(argv: readonly string[]): CliArgs | undefined {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" } },
    });

    return { help: values.help === true, command: positionals[0] };
  } catch {
    return undefined;
  }
}

/** Parses arguments, wires the application, and returns the process exit code. */
export function runCli(argv: readonly string[], io: CliIo): number {
  const configResult = loadConfig(io.env);

  if (!configResult.ok) {
    io.stderr(`Invalid configuration:\n  ${configResult.issues.join("\n  ")}\n`);

    return EXIT_CONFIG;
  }

  const { logger } = createApplication(configResult.config);

  const args = parseCliArgs(argv);

  if (args?.help === true) {
    io.stdout(USAGE);

    return EXIT_OK;
  }

  logger.warn("cli.usage_error", { command: args?.command ?? null });
  io.stderr(USAGE);

  return EXIT_USAGE;
}
