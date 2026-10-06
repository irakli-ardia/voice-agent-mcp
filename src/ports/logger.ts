/** A JSON-serialisable log value. Errors and payloads are mapped to these before logging. */
export type LogValue = string | number | boolean | null | readonly LogValue[] | LogFields;

export interface LogFields {
  readonly [field: string]: LogValue | undefined;
}

/** Structured logger. Messages are constant event names; data goes in `fields`. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}
