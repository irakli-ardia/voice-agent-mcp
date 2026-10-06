import type { JsonObject } from "../domain/json-value.js";
import type { Result } from "../domain/result.js";
import type { ToolExecutionError } from "../domain/tool-execution-error.js";

/** A tool as the model sees it: parameters are a JSON Schema projected from the canonical schema. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
}

/**
 * A function call the model requested. Nothing in it is trusted. `arguments` is the decoded JSON
 * value, or `undefined` when the provider's arguments were missing or could not be decoded.
 */
export interface ModelToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * One entry of the runner's per-turn transcript. `continuation` is the adapter's own protocol
 * state for the step: the runner carries it to the next request and never reads it.
 */
export type TranscriptItem<Continuation> =
  | { readonly kind: "user_text"; readonly text: string }
  | {
      readonly kind: "model_step";
      readonly text: string | null;
      readonly toolCalls: readonly ModelToolCall[];
      readonly continuation: Continuation;
    }
  | {
      readonly kind: "tool_result";
      readonly callId: string;
      readonly result: Result<JsonObject, ToolExecutionError>;
    };

export interface ModelRequest<Continuation> {
  readonly instructions: string;
  readonly tools: readonly ModelTool[];
  readonly transcript: readonly TranscriptItem<Continuation>[];
}

/** One completed model response: text (`null` when it has none) and calls in response order. */
export interface ModelStep<Continuation> {
  readonly text: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly continuation: Continuation;
}

export type ModelFailureCode =
  | "unavailable"
  | "rejected"
  | "context_too_large"
  | "incomplete"
  | "refused"
  | "protocol_error";

/** A failed model invocation: a code only, never provider text, status, ids, or headers. */
export interface ModelFailure {
  readonly code: ModelFailureCode;
}

/**
 * The model behind the agent loop. Stateless: every request carries the whole transcript.
 * `respond` resolves for every outcome, retries transient failures inside one invocation, and
 * rejects only when `signal` aborts.
 */
export interface AgentModel<Continuation> {
  respond(
    request: ModelRequest<Continuation>,
    signal: AbortSignal,
  ): Promise<Result<ModelStep<Continuation>, ModelFailure>>;
}
