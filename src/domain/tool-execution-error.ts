/**
 * Every way a tool call can fail, as the caller sees it. `timed_out` and `cancelled` mean the
 * executor stopped waiting: the handler may still have run, so the outcome is unknown.
 */
export type ToolErrorCode =
  | "unknown_tool"
  | "invalid_input"
  | "confirmation_required"
  | "cancelled"
  | "timed_out"
  | "execution_failed"
  | "internal_error"
  | "invalid_output"
  | "output_too_large";

/** A failed tool call. `message` is always safe to show a model or MCP client. */
export interface ToolExecutionError {
  readonly code: ToolErrorCode;
  readonly message: string;
}

/**
 * Bound on every tool error message, as the UTF-8 byte length of `JSON.stringify(message)`, so
 * JSON escaping is included and a serialised error has an exact maximum size.
 */
export const MAX_TOOL_ERROR_MESSAGE_JSON_BYTES = 1024;

export function toolErrorMessageJsonBytes(message: string): number {
  return new TextEncoder().encode(JSON.stringify(message)).byteLength;
}
