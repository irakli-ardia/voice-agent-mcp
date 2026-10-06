import type { z } from "zod";
import type { JsonObject } from "../../domain/json-value.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  MAX_TOOL_ERROR_MESSAGE_JSON_BYTES,
  type ToolErrorCode,
  type ToolExecutionError,
  toolErrorMessageJsonBytes,
} from "../../domain/tool-execution-error.js";
import type { Clock } from "../../ports/clock.js";
import type { LogFields, Logger } from "../../ports/logger.js";
import type {
  BoundToolHandler,
  ToolCall,
  ToolDefinition,
  ToolFailure,
} from "../../tools/tool-definition.js";
import { TOOL_CALL_ID_PATTERN } from "./tool-call-id.js";
import { TOOL_NAME_PATTERN, type ToolRegistry } from "./tool-registry.js";

/**
 * Runs one tool call through the canonical pipeline. Never throws: every outcome is a result whose
 * error message is safe to show a model or MCP client.
 */
export type ToolExecutor = (
  call: ToolCall,
  signal: AbortSignal,
) => Promise<Result<JsonObject, ToolExecutionError>>;

export interface ToolExecutorDependencies {
  readonly registry: ToolRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  /**
   * Cap on the UTF-8 byte length of a successful result's JSON. It bounds what leaves the executor;
   * it does not bound memory a handler allocates before its output is validated.
   */
  readonly maxResultBytes: number;
}

/** Fixed public messages; the other two codes carry a message built for the call. */
const MESSAGES = {
  unknown_tool: "No tool with this name exists.",
  confirmation_required: "This tool requires confirmation from the user, which was not given.",
  cancelled: "The tool call was cancelled; its outcome is unknown.",
  timed_out: "The tool did not finish within its time limit; its outcome is unknown.",
  internal_error: "The tool failed unexpectedly.",
  invalid_output: "The tool produced an invalid result.",
  output_too_large: "The tool result is too large to return.",
} satisfies {
  readonly [Code in Exclude<ToolErrorCode, "invalid_input" | "execution_failed">]: string;
};

const MAX_REPORTED_ISSUES = 10;

/** Used when not even one issue fits within `MAX_TOOL_ERROR_MESSAGE_JSON_BYTES`. */
const UNDESCRIBED_INPUT_ISSUES = "Invalid arguments.";

const MAX_LOGGED_ERROR_MESSAGE = 500;

/** What a thrown value may contribute to a log event: never the value itself. */
type CauseDetails = { readonly errorName: string; readonly errorMessage?: string };

/** How an invoked handler finished. Never rejects: a thrown value is mapped to `threw`. */
type HandlerSettlement =
  | { readonly status: "returned"; readonly value: Result<JsonObject, ToolFailure> }
  | { readonly status: "threw"; readonly details: CauseDetails };

/** When the executor stops waiting, `late` still tracks the handler, which may finish afterwards. */
type Settlement =
  | { readonly status: "cancelled" | "timed_out"; readonly late: Promise<HandlerSettlement> }
  | HandlerSettlement;

/** One call's result plus what the log event needs; `details` never holds arguments or output. */
interface Outcome {
  readonly result: Result<JsonObject, ToolExecutionError>;
  readonly handlerInvoked: boolean;
  readonly details: LogFields;
  /** Set when the result is `cancelled` or `timed_out` after the handler was invoked. */
  readonly late?: Promise<HandlerSettlement>;
}

function failed(
  code: keyof typeof MESSAGES,
  handlerInvoked: boolean,
  details: LogFields = {},
): Outcome {
  return { result: err({ code, message: MESSAGES[code] }), handlerInvoked, details };
}

function describeInputIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");

  // Zod's message for this code lists the unexpected key names, which come from the caller.
  const what =
    issue.code === "unrecognized_keys" ? "unknown properties are not allowed" : issue.message;

  return `${where}: ${what}`;
}

function renderInputIssues(described: readonly string[], omitted: number): string {
  const suffix = omitted > 0 ? `; and ${omitted} more` : "";

  return `Invalid arguments: ${described.join("; ")}${suffix}.`;
}

/**
 * Builds a safe message: paths and Zod's type-level messages only, never the rejected values. At
 * most ten issues, and only as many as keep the serialised message within its byte bound; the
 * rest are counted.
 */
function describeInputIssues(issues: readonly z.core.$ZodIssue[]): string {
  let described: readonly string[] = [];
  let message = UNDESCRIBED_INPUT_ISSUES;

  for (const issue of issues.slice(0, MAX_REPORTED_ISSUES)) {
    const candidate = [...described, describeInputIssue(issue)];
    const rendered = renderInputIssues(candidate, issues.length - candidate.length);

    if (toolErrorMessageJsonBytes(rendered) > MAX_TOOL_ERROR_MESSAGE_JSON_BYTES) {
      break;
    }

    described = candidate;
    message = rendered;
  }

  return message;
}

/**
 * The thrown value stays private: only its name and message reach the error log. Total, because
 * it runs inside the executor's last catch: a thrown value with odd properties must not escape.
 */
function describeCause(cause: unknown): CauseDetails {
  try {
    return cause instanceof Error
      ? {
          errorName: String(cause.name),
          errorMessage: String(cause.message).slice(0, MAX_LOGGED_ERROR_MESSAGE),
        }
      : { errorName: "non_error_thrown" };
  } catch {
    return { errorName: "unreadable_error" };
  }
}

/**
 * Invokes the handler and waits for it, the deadline, or the caller's signal. Precedence is
 * decided from the abort flags once waiting ends, never from which promise won the race:
 * caller cancellation, then the deadline, then the handler's settlement. Neither abort stops a
 * handler that ignores its signal; the executor only stops waiting.
 */
async function settle(
  handler: BoundToolHandler,
  tool: ToolDefinition,
  callerSignal: AbortSignal,
  clock: Clock,
): Promise<Settlement> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), tool.timeoutMs);
  const signal = AbortSignal.any([callerSignal, deadline.signal]);
  const aborted = Promise.withResolvers<"aborted">();
  const stopWaiting = (): void => aborted.resolve("aborted");

  signal.addEventListener("abort", stopWaiting, { once: true });

  // An already-aborted signal never fires "abort"; without this, waiting would rest on the handler.
  if (signal.aborted) {
    stopWaiting();
  }

  try {
    // A rejection becomes a settlement too, so the precedence below also covers a handler that
    // rejects; the race's subscription keeps a rejection after we stop waiting from going unhandled.
    const handled = handler({ signal, clock }).then(
      (value): HandlerSettlement => ({ status: "returned", value }),
      (cause: unknown): HandlerSettlement => ({ status: "threw", details: describeCause(cause) }),
    );

    const first = await Promise.race([handled, aborted.promise]);

    if (callerSignal.aborted) {
      return { status: "cancelled", late: handled };
    }

    // "aborted" without the caller's flag can only mean the deadline; the check narrows `first`.
    if (deadline.signal.aborted || first === "aborted") {
      return { status: "timed_out", late: handled };
    }

    return first;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", stopWaiting);
  }
}

function validateOutput(
  tool: ToolDefinition,
  value: Result<JsonObject, ToolFailure>,
  maxResultBytes: number,
): Outcome {
  if (!value.ok) {
    return {
      result: err({ code: "execution_failed", message: value.error.message }),
      handlerInvoked: true,
      details: { failureReason: value.error.reason },
    };
  }

  const output = tool.outputSchema.safeParse(value.value);

  if (!output.success) {
    return failed("invalid_output", true, {
      issues: output.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
        path: issue.path.map(String).join("."),
        code: issue.code,
      })),
    });
  }

  const resultBytes = new TextEncoder().encode(JSON.stringify(output.data)).byteLength;

  if (resultBytes > maxResultBytes) {
    return failed("output_too_large", true, { resultBytes });
  }

  return { result: ok(output.data), handlerInvoked: true, details: {} };
}

async function run(
  tool: ToolDefinition,
  call: ToolCall,
  signal: AbortSignal,
  dependencies: ToolExecutorDependencies,
): Promise<Outcome> {
  let handlerInvoked = false;

  try {
    const bound = tool.bindArguments(call);

    if (!bound.ok) {
      return {
        result: err({ code: "invalid_input", message: describeInputIssues(bound.error) }),
        handlerInvoked,
        details: { issueCount: bound.error.length },
      };
    }

    // Policy. No host confirmation channel exists yet (M6), so confirmation fails closed.
    if (tool.requiresConfirmation) {
      return failed("confirmation_required", handlerInvoked);
    }

    if (signal.aborted) {
      return failed("cancelled", handlerInvoked);
    }

    handlerInvoked = true;
    const settlement = await settle(bound.value, tool, signal, dependencies.clock);

    switch (settlement.status) {
      case "cancelled":
      case "timed_out":
        return { ...failed(settlement.status, handlerInvoked), late: settlement.late };
      case "threw":
        return failed("internal_error", handlerInvoked, settlement.details);
      case "returned":
        return validateOutput(tool, settlement.value, dependencies.maxResultBytes);
    }
  } catch (cause) {
    return failed("internal_error", handlerInvoked, describeCause(cause));
  }
}

/** Failures that point at a defect in a tool or its schemas rather than an expected outcome. */
const DEFECT_CODES: ReadonlySet<ToolErrorCode> = new Set(["internal_error", "invalid_output"]);

/**
 * The requested name is caller-supplied text, logged only when it has a tool name's form. Every
 * registered name has that form, and lookup is exact, so a found tool always logs its own name.
 */
function loggableToolName(name: string): string | null {
  return TOOL_NAME_PATTERN.test(name) ? name : null;
}

function loggableToolCallId(id: string): string | null {
  return TOOL_CALL_ID_PATTERN.test(id) ? id : null;
}

function log(
  logger: Logger,
  call: ToolCall,
  tool: ToolDefinition | undefined,
  outcome: Outcome,
  durationMs: number,
): void {
  const { result } = outcome;

  const fields: LogFields = {
    toolCallId: loggableToolCallId(call.id),
    toolName: loggableToolName(call.name),
    risk: tool?.risk ?? null,
    outcome: result.ok ? "ok" : result.error.code,
    handlerInvoked: outcome.handlerInvoked,
    durationMs,
    ...outcome.details,
  };

  if (result.ok) {
    logger.info("tool.completed", fields);

    return;
  }

  logger[DEFECT_CODES.has(result.error.code) ? "error" : "warn"]("tool.failed", fields);
}

/** Only the declared failure reason or the thrown value's name: never output or thrown data. */
function lateOutcomeFields(settlement: HandlerSettlement): LogFields {
  if (settlement.status === "threw") {
    return { lateOutcome: "threw", errorName: settlement.details.errorName };
  }

  return settlement.value.ok
    ? { lateOutcome: "returned" }
    : { lateOutcome: "failed", failureReason: settlement.value.error.reason };
}

/**
 * After a `cancelled` or `timed_out` result, logs `tool.settled_late` if the handler finishes
 * anyway — the evidence that a write the caller saw as "outcome unknown" did complete. The caller's
 * result is already returned and never changes.
 */
function watchLateSettlement(
  dependencies: ToolExecutorDependencies,
  call: ToolCall,
  tool: ToolDefinition,
  late: Promise<HandlerSettlement>,
  startedAt: number,
): void {
  void late.then((settlement) => {
    try {
      dependencies.logger.warn("tool.settled_late", {
        toolCallId: loggableToolCallId(call.id),
        toolName: tool.name,
        risk: tool.risk,
        durationMs: dependencies.clock.monotonicNow() - startedAt,
        ...lateOutcomeFields(settlement),
      });
    } catch {
      // A failing logger must not turn a late settlement into an unhandled rejection.
    }
  });
}

/**
 * The one pipeline every tool call passes: lookup → validate input → policy → cancellation check
 * → deadline + execute → validate output → size cap → one outcome log event, plus
 * `tool.settled_late` if a handler finishes after the executor stopped waiting.
 */
export function createToolExecutor(dependencies: ToolExecutorDependencies): ToolExecutor {
  return async (
    call: ToolCall,
    signal: AbortSignal,
  ): Promise<Result<JsonObject, ToolExecutionError>> => {
    const startedAt = dependencies.clock.monotonicNow();
    const tool = dependencies.registry.find(call.name);

    const outcome =
      tool === undefined
        ? failed("unknown_tool", false)
        : await run(tool, call, signal, dependencies);

    log(dependencies.logger, call, tool, outcome, dependencies.clock.monotonicNow() - startedAt);

    if (tool !== undefined && outcome.late !== undefined) {
      watchLateSettlement(dependencies, call, tool, outcome.late, startedAt);
    }

    return outcome.result;
  };
}
