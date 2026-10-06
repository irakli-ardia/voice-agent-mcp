import type OpenAI from "openai";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseOutputMessage,
} from "openai/resources/responses/responses";
import type { JsonObject } from "../../domain/json-value.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { ToolExecutionError } from "../../domain/tool-execution-error.js";
import type {
  AgentModel,
  ModelFailure,
  ModelRequest,
  ModelStep,
  ModelTool,
  ModelToolCall,
  TranscriptItem,
} from "../../ports/agent-model.js";
import type { Clock } from "../../ports/clock.js";
import type { LogFields, Logger } from "../../ports/logger.js";
import { classifyOpenAiError, type OpenAiFailure } from "./openai-failure.js";
import { type AttemptOutcome, type RetryPolicy, runWithRetries } from "./retry-policy.js";

/**
 * The adapter's opaque protocol state for one model step: the step's supported output items, as
 * input items, replayed verbatim (encrypted reasoning, message `phase`, call ids) in later requests.
 */
export type OpenAiContinuation = readonly ResponseInputItem[];

export interface ResponsesAgentModelOptions {
  readonly client: OpenAI;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly reasoningEffort: "none" | "low";
  readonly retry: RetryPolicy;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** Incomplete reasons are logged only in this form; anything else is logged as `null`. */
const SAFE_ENUM_PATTERN = /^[a-z0-9_]{1,64}$/;

/** The tool-result envelope; key order is part of the documented size bound. */
function functionCallOutput(result: Result<JsonObject, ToolExecutionError>): string {
  return result.ok
    ? JSON.stringify({ ok: true, result: result.value })
    : JSON.stringify({
        ok: false,
        error: { code: result.error.code, message: result.error.message },
      });
}

function inputItems(item: TranscriptItem<OpenAiContinuation>): readonly ResponseInputItem[] {
  switch (item.kind) {
    case "user_text":
      return [{ role: "user", content: item.text }];
    case "model_step":
      return item.continuation;
    case "tool_result":
      return [
        {
          type: "function_call_output",
          call_id: item.callId,
          output: functionCallOutput(item.result),
        },
      ];
  }
}

function functionTool(tool: ModelTool): FunctionTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: true,
  };
}

function requestBody(
  options: ResponsesAgentModelOptions,
  request: ModelRequest<OpenAiContinuation>,
): ResponseCreateParamsNonStreaming {
  return {
    model: options.model,
    instructions: request.instructions,
    input: request.transcript.flatMap(inputItems),
    tools: request.tools.map(functionTool),
    store: false,
    truncation: "disabled",
    include: ["reasoning.encrypted_content"],
    max_output_tokens: options.maxOutputTokens,
    parallel_tool_calls: true,
    reasoning: { effort: options.reasoningEffort },
  };
}

/** Decoded arguments, or `undefined` when they are not valid JSON; the raw text is dropped. */
function decodeArguments(raw: string): ModelToolCall["arguments"] {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRunnableCall(call: ResponseFunctionToolCall): boolean {
  return (
    call.status === "completed" &&
    call.async !== true &&
    (call.caller === undefined || call.caller === null || call.caller.type === "direct") &&
    (call.namespace === undefined || call.namespace === "")
  );
}

/** Text parts of one message, or `refused` if it contains a refusal. */
function messageText(message: ResponseOutputMessage): string | "refused" {
  let text = "";

  for (const part of message.content) {
    if (part.type === "refusal") {
      return "refused";
    }

    text += part.text;
  }

  return text;
}

interface MappedStep {
  readonly step: Result<ModelStep<OpenAiContinuation>, ModelFailure>;
  readonly details: LogFields;
}

function failed(code: ModelFailure["code"], details: LogFields = {}): MappedStep {
  return { step: err({ code }), details };
}

/** One supported output item, as the step needs it; `failure` ends the mapping. */
type MappedItem =
  | { readonly kind: "reasoning"; readonly item: ResponseInputItem }
  | { readonly kind: "text"; readonly text: string; readonly item: ResponseInputItem }
  | { readonly kind: "call"; readonly call: ModelToolCall; readonly item: ResponseInputItem }
  | { readonly kind: "failure"; readonly code: "refused" | "protocol_error" };

function mapOutputItem(item: ResponseOutputItem): MappedItem {
  if (item.type === "reasoning") {
    return { kind: "reasoning", item };
  }

  if (item.type === "message" && item.role === "assistant" && item.status === "completed") {
    const text = messageText(item);

    return text === "refused" ? { kind: "failure", code: "refused" } : { kind: "text", text, item };
  }

  if (item.type === "function_call" && isRunnableCall(item)) {
    const call = {
      callId: item.call_id,
      name: item.name,
      arguments: decodeArguments(item.arguments),
    };

    return { kind: "call", call, item };
  }

  return { kind: "failure", code: "protocol_error" };
}

/** A response that did not complete is never a step, so none of its calls can run. */
function notCompleted(response: Response): MappedStep {
  if (response.status !== "incomplete") {
    return failed("protocol_error", { problem: "response_not_completed" });
  }

  const reason = response.incomplete_details?.reason ?? "";

  return failed("incomplete", { incompleteReason: SAFE_ENUM_PATTERN.test(reason) ? reason : null });
}

/**
 * Maps a completed response to a canonical step. Only assistant messages, direct function calls,
 * and reasoning items are supported; anything else, or a response that is not `completed`, is a
 * failure, and no call from it reaches the runner.
 */
function mapResponse(response: Response): MappedStep {
  if (response.status !== "completed") {
    return notCompleted(response);
  }

  const texts: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  const continuation: ResponseInputItem[] = [];

  for (const output of response.output) {
    const mapped = mapOutputItem(output);

    if (mapped.kind === "failure") {
      return mapped.code === "refused"
        ? failed("refused")
        : failed("protocol_error", { problem: "unsupported_output_item" });
    }

    if (mapped.kind === "text") {
      texts.push(mapped.text);
    } else if (mapped.kind === "call") {
      toolCalls.push(mapped.call);
    }

    continuation.push(mapped.item);
  }

  return {
    step: ok({ text: texts.length === 0 ? null : texts.join("\n"), toolCalls, continuation }),
    details: {
      toolCalls: toolCalls.length,
      undecodableArguments: toolCalls.filter((call) => call.arguments === undefined).length,
    },
  };
}

function usageFields(response: Response): LogFields {
  const usage = response.usage;

  return usage === undefined
    ? {}
    : {
        inputTokens: usage.input_tokens,
        cachedInputTokens: usage.input_tokens_details.cached_tokens,
        outputTokens: usage.output_tokens,
        reasoningTokens: usage.output_tokens_details.reasoning_tokens,
      };
}

type AttemptResult =
  | { readonly kind: "response"; readonly response: Response }
  | { readonly kind: "failure"; readonly failure: OpenAiFailure };

/**
 * `AgentModel` over the OpenAI Responses API, stateless: every request carries the whole
 * transcript, rebuilt from canonical items plus each step's continuation, with `store: false`.
 * Never `previous_response_id`, a conversation, or background mode. Transient failures are retried
 * inside one invocation; the promise rejects only when `signal` aborts. Logs one event per
 * invocation with metadata only — never prompts, text, arguments, results, or provider messages.
 */
export function createResponsesAgentModel(
  options: ResponsesAgentModelOptions,
): AgentModel<OpenAiContinuation> {
  const attempt = async (
    body: ResponseCreateParamsNonStreaming,
    signal: AbortSignal,
  ): Promise<AttemptOutcome<AttemptResult>> => {
    try {
      const response = await options.client.responses.create(body, { signal, maxRetries: 0 });

      return { retry: false, value: { kind: "response", response } };
    } catch (cause) {
      const outcome = classifyOpenAiError(
        cause instanceof Error ? cause : new Error("non-error thrown"),
        signal,
      );

      const value: AttemptResult = { kind: "failure", failure: outcome.value };

      return outcome.retry ? { ...outcome, value } : { retry: false, value };
    }
  };

  return {
    respond: async (request, signal) => {
      const startedAt = options.clock.monotonicNow();
      const body = requestBody(options, request);

      const { value, attempts } = await runWithRetries(
        () => attempt(body, signal),
        options.retry,
        signal,
      );

      const base: LogFields = {
        provider: "openai",
        model: options.model,
        attempts,
        durationMs: options.clock.monotonicNow() - startedAt,
      };

      if (value.kind === "failure") {
        const { code, httpStatus, providerCode } = value.failure;

        options.logger.warn("model.request_failed", {
          ...base,
          outcome: code,
          httpStatus,
          providerCode,
        });

        return err({ code });
      }

      const mapped = mapResponse(value.response);
      const outcome = mapped.step.ok ? "ok" : mapped.step.error.code;
      const fields = { ...base, outcome, ...usageFields(value.response), ...mapped.details };

      if (mapped.step.ok) {
        options.logger.info("model.request_completed", fields);
      } else {
        options.logger.warn("model.request_failed", fields);
      }

      return mapped.step;
    },
  };
}
