import type { ToolDefinition } from "../../tools/tool-definition.js";

/** snake_case, at most 64 characters: valid for both OpenAI function names and MCP tool names. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** `setTimeout` runs any delay outside 1..2^31-1 ms after ~1 ms, so such a budget would be a bug. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
