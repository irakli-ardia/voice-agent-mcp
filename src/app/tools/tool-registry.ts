import {
  MAX_TOOL_ERROR_MESSAGE_JSON_BYTES,
  toolErrorMessageJsonBytes,
} from "../../domain/tool-execution-error.js";
import type { ToolDefinition } from "../../tools/tool-definition.js";

/** snake_case, at most 64 characters: valid for both OpenAI function names and MCP tool names. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** `setTimeout` runs any delay outside 1..2^31-1 ms after ~1 ms, so such a budget would be a bug. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A key in the form the agent host derives (43 base64url characters); a keyed tool must accept it. */
const HOST_DERIVED_KEY_SAMPLE = "Aa0_-".repeat(9).slice(0, 43);

/**
 * `idempotency: "key"` and the input's `idempotencyKey` field must agree in both directions: the
 * runner injects a key only for `key` tools, and the model-facing schema hides the field only for
 * them, so a mismatch would either show the model the key or send the executor a call without one.
 */
function assertIdempotencyContract(tool: ToolDefinition): void {
  const hasKeyField = Object.hasOwn(tool.inputSchema.shape, "idempotencyKey");

  if (tool.idempotency === "none") {
    if (hasKeyField) {
      throw new Error(
        `Tool "${tool.name}" takes an idempotencyKey but declares idempotency "none".`,
      );
    }

    return;
  }

  const keyField = hasKeyField ? tool.inputSchema.pick({ idempotencyKey: true }) : undefined;

  if (
    keyField === undefined ||
    !keyField.safeParse({ idempotencyKey: HOST_DERIVED_KEY_SAMPLE }).success ||
    keyField.safeParse({}).success ||
    keyField.safeParse({ idempotencyKey: null }).success
  ) {
    throw new Error(
      `Tool "${tool.name}" declares idempotency "key" but its input lacks the required ` +
        "idempotencyKey string that accepts a host-derived key.",
    );
  }
}

function assertFailureMessagesBounded(tool: ToolDefinition): void {
  for (const failure of tool.failures) {
    if (toolErrorMessageJsonBytes(failure.message) > MAX_TOOL_ERROR_MESSAGE_JSON_BYTES) {
      throw new Error(
        `Tool "${tool.name}" failure "${failure.reason}" has a message over ` +
          `${MAX_TOOL_ERROR_MESSAGE_JSON_BYTES} serialised bytes.`,
      );
    }
  }
}

/** The canonical set of tools, looked up by exact name only. */
export interface ToolRegistry {
  /** Every registered tool, in registration order. */
  readonly tools: readonly ToolDefinition[];
  find(name: string): ToolDefinition | undefined;
}

function assertRegistrable(
  tool: ToolDefinition,
  registered: ReadonlyMap<string, ToolDefinition>,
): void {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new Error(`Tool name "${tool.name}" must be snake_case and at most 64 characters.`);
  }

  if (registered.has(tool.name)) {
    throw new Error(`Tool name "${tool.name}" is registered more than once.`);
  }

  if (
    !Number.isSafeInteger(tool.timeoutMs) ||
    tool.timeoutMs < 1 ||
    tool.timeoutMs > MAX_TIMER_DELAY_MS
  ) {
    throw new Error(
      `Tool "${tool.name}" needs an integer timeoutMs between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  }

  assertIdempotencyContract(tool);
  assertFailureMessagesBounded(tool);
}

/** Builds the registry once at startup; an invalid or duplicate definition is a programmer error. */
export function createToolRegistry(tools: readonly ToolDefinition[]): ToolRegistry {
  const byName = new Map<string, ToolDefinition>();

  for (const tool of tools) {
    assertRegistrable(tool, byName);
    byName.set(tool.name, tool);
  }

  return {
    tools: [...byName.values()],
    find: (name: string): ToolDefinition | undefined => byName.get(name),
  };
}
