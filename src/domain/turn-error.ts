/**
 * Every way an agent turn can end without a final answer. `cancelled` and `turn_timed_out` stop the
 * turn wherever it is; tool calls already executed are not rolled back.
 */
export type TurnErrorCode =
  | "cancelled"
  | "turn_timed_out"
  | "iteration_limit_exceeded"
  | "tool_call_limit_exceeded"
  | "model_unavailable"
  | "model_rejected"
  | "context_too_large"
  | "model_incomplete"
  | "model_refused"
  | "model_protocol_error"
  | "internal_error";

/** A failed turn. `message` is static and safe to show the user. */
export interface TurnError {
  readonly code: TurnErrorCode;
  readonly message: string;
}
