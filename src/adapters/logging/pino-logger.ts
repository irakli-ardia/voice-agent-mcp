import { type DestinationStream, type Logger as PinoLogger, pino } from "pino";
import type { LogLevel } from "../../config/config.js";
import type { LogFields, Logger } from "../../ports/logger.js";

const STDERR_FD = 2;

const REDACTED_PATHS = [
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "OPENAI_API_KEY",
  "*.OPENAI_API_KEY",
];

export interface PinoLoggerOptions {
  readonly level: LogLevel;
  /** Defaults to stderr: stdout is reserved for command output and MCP protocol traffic. */
  readonly destination?: DestinationStream;
}

export function createPinoLogger(options: PinoLoggerOptions): Logger {
  const destination = options.destination ?? pino.destination({ dest: STDERR_FD, sync: true });

  return wrap(
    pino(
      { level: options.level, redact: { paths: REDACTED_PATHS, censor: "[redacted]" } },
      destination,
    ),
  );
}

function wrap(logger: PinoLogger): Logger {
  return {
    debug: (message: string, fields?: LogFields): void => logger.debug(fields ?? {}, message),
    info: (message: string, fields?: LogFields): void => logger.info(fields ?? {}, message),
    warn: (message: string, fields?: LogFields): void => logger.warn(fields ?? {}, message),
    error: (message: string, fields?: LogFields): void => logger.error(fields ?? {}, message),
    child: (bindings: LogFields): Logger => wrap(logger.child(bindings)),
  };
}
