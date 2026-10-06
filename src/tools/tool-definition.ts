import type { z } from "zod";
import type { JsonObject } from "../domain/json-value.js";
import { err, ok, type Result } from "../domain/result.js";
import type { Clock } from "../ports/clock.js";

/** A request to run a named tool. Comes from a model or an MCP client: nothing in it is trusted. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw, unvalidated arguments; only the tool's input schema may interpret them. */
  readonly arguments: unknown;
}

/** What a handler may use. Aborted when the executor stops waiting (deadline or caller). */
export interface ToolContext {
  readonly signal: AbortSignal;
  readonly clock: Clock;
}

export type RiskLevel = "read" | "write" | "destructive" | "external";

/** An expected failure: a declared reason (safe to log) and its static, client-safe message. */
export interface ToolFailure {
  readonly reason: string;
  readonly message: string;
}

/** A destructive tool always requires confirmation; the type does not let it opt out. */
type ToolSafety =
  | { readonly risk: "destructive"; readonly requiresConfirmation: true }
  | { readonly risk: Exclude<RiskLevel, "destructive">; readonly requiresConfirmation: boolean };

/**
 * What a tool author writes. Failure reasons are inferred only from `failures`, whose keys
 * `defineTool` requires to be literals, so a handler can return a declared reason but never a
 * runtime string such as a caught error's message.
 */
export type ToolSpec<
  Input extends z.ZodObject,
  Output extends JsonObject,
  Failure extends string,
> = ToolSafety & {
  readonly name: string;
  readonly description: string;
  readonly timeoutMs: number;
  readonly inputSchema: Input;
  readonly outputSchema: z.ZodType<Output, Output>;
  /** Static messages, one per expected failure reason; shown to models and MCP clients. */
  readonly failures: { readonly [Reason in Failure]: string };
  readonly execute: (
    input: z.output<Input>,
    context: ToolContext,
  ) => Promise<Result<Output, NoInfer<Failure>>>;
};

/**
 * Rejects a `failures` table whose keys are not a finite set of literal reasons: a `string` or
 * template-pattern key would let a handler return runtime text, such as a caught error's message.
 * Such a table maps to an index signature, which an empty object satisfies; literal keys do not.
 */
type LiteralFailureReasons<Failure extends string> = [Failure] extends [never]
  ? unknown
  : Record<never, never> extends { readonly [Reason in Failure]: string }
    ? { readonly failures: "declare each failure reason as a literal key" }
    : unknown;

/** A handler already bound to validated input, waiting only for its context. */
export type BoundToolHandler = (context: ToolContext) => Promise<Result<JsonObject, ToolFailure>>;

type ToolInputIssues = readonly z.core.$ZodIssue[];

/** The canonical, registry-ready tool: metadata and schemas, with its input type erased. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly risk: RiskLevel;
  readonly requiresConfirmation: boolean;
  readonly timeoutMs: number;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType<JsonObject>;
  /** Every expected failure the tool may report, with its static, client-safe message. */
  readonly failures: readonly ToolFailure[];
  /** Validates the call's arguments; on success returns the handler bound to the parsed input. */
  readonly bindArguments: (call: ToolCall) => Result<BoundToolHandler, ToolInputIssues>;
}

/**
 * The only generic step. Input and output types are known inside this closure, so the parsed input
 * provably matches the handler's parameter; callers get a non-generic definition, with no casts.
 */
export function defineTool<
  Input extends z.ZodObject,
  Output extends JsonObject,
  Failure extends string = never,
>(spec: ToolSpec<Input, Output, Failure> & LiteralFailureReasons<Failure>): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    risk: spec.risk,
    requiresConfirmation: spec.requiresConfirmation,
    timeoutMs: spec.timeoutMs,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    failures: Object.entries<string>(spec.failures).map(([reason, message]) => ({
      reason,
      message,
    })),
    bindArguments: (call: ToolCall): Result<BoundToolHandler, ToolInputIssues> => {
      const parsed = spec.inputSchema.safeParse(call.arguments);

      if (!parsed.success) {
        return err(parsed.error.issues);
      }

      const input = parsed.data;

      return ok(async (context: ToolContext): Promise<Result<JsonObject, ToolFailure>> => {
        const outcome = await spec.execute(input, context);

        return outcome.ok
          ? outcome
          : err({ reason: outcome.error, message: spec.failures[outcome.error] });
      });
    },
  };
}
