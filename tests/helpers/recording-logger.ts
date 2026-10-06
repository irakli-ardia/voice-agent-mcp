import type { LogFields, Logger } from "../../src/ports/logger.js";

export type LogLevelName = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly level: LogLevelName;
  readonly message: string;
  /** Child bindings merged with the call's fields, as a structured logger would emit them. */
  readonly fields: LogFields;
}

export interface RecordingLogger extends Logger {
  readonly entries: readonly LogEntry[];
}

/** A `Logger` that keeps every entry in memory, so tests can assert what was (not) logged. */
export function createRecordingLogger(): RecordingLogger {
  const entries: LogEntry[] = [];

  const build = (bindings: LogFields): Logger => {
    const record =
      (level: LogLevelName) =>
      (message: string, fields?: LogFields): void => {
        entries.push({ level, message, fields: { ...bindings, ...fields } });
      };

    return {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      child: (childBindings: LogFields): Logger => build({ ...bindings, ...childBindings }),
    };
  };

  return { ...build({}), entries };
}
