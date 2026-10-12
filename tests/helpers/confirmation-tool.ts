import { z } from "zod";
import { ok } from "../../src/domain/result.js";
import { defineTool, type ToolDefinition } from "../../src/tools/tool-definition.js";

export interface WipeTool {
  readonly tool: ToolDefinition;
  readonly runs: readonly { readonly target: string }[];
}

/**
 * A test-only destructive tool, never part of the product: its handler records every run, so
 * "nothing happened" is a count of zero. It stands in for a tool that requires confirmation.
 */
export function createWipeTool(): WipeTool {
  const runs: { readonly target: string }[] = [];

  const tool = defineTool({
    name: "wipe",
    description: "Test only: pretends to destroy something.",
    risk: "destructive",
    requiresConfirmation: true,
    idempotency: "none",
    timeoutMs: 1_000,
    inputSchema: z.strictObject({ target: z.string().max(40) }),
    outputSchema: z.strictObject({ wiped: z.string() }),
    failures: {},
    execute: async ({ target }) => {
      runs.push({ target });

      return ok({ wiped: target });
    },
  });

  return { tool, runs };
}
