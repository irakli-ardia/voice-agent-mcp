import type { Tool, ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { JsonObject } from "../../domain/json-value.js";
import type { ToolDefinition } from "../../tools/tool-definition.js";

const jsonObjectSchema = z.record(z.string(), z.json());

/**
 * JSON Schema 2020-12 is the MCP default dialect, so the `$schema` keyword Zod writes adds nothing
 * and is dropped. Everything else is Zod's own output for the canonical schema, so the keyed
 * tools keep their required `idempotencyKey`: MCP clients own it.
 */
function projectSchema(schema: z.ZodType, io: "input" | "output"): JsonObject {
  const projected = jsonObjectSchema.parse(z.toJSONSchema(schema, { io }));

  return Object.fromEntries(Object.entries(projected).filter(([keyword]) => keyword !== "$schema"));
}

/**
 * The hints, derived only from the tool's declared risk and idempotency (clients treat every hint
 * as untrusted, but it must not be wrong):
 *
 * - `readOnlyHint`: `read` tools do not modify their environment. For them `destructiveHint` and
 *   `idempotentHint` are meaningless (spec: "meaningful only when readOnlyHint == false") and omitted.
 * - `destructiveHint`: false only for `write`, because the risk taxonomy makes any tool that
 *   removes or overwrites data `destructive` (which requires confirmation). `external` effects are
 *   undecided by the taxonomy, so the spec's conservative default (true) is stated explicitly.
 * - `idempotentHint`: true only for `idempotency: "key"`, whose contract is that a repeated key
 *   never repeats the effect. `none` says nothing about repeats, so the hint stays false.
 * - `openWorldHint`: true only for `external` tools; every other tool works inside the
 *   application's own data. The spec default (true) would be wrong for them.
 */
function projectAnnotations(tool: ToolDefinition): ToolAnnotations {
  const openWorldHint = tool.risk === "external";

  if (tool.risk === "read") {
    return { readOnlyHint: true, openWorldHint };
  }

  return {
    readOnlyHint: false,
    destructiveHint: tool.risk !== "write",
    idempotentHint: tool.idempotency === "key",
    openWorldHint,
  };
}

function describeTool(tool: ToolDefinition): Tool {
  const outputSchema = projectSchema(tool.outputSchema, "output");

  // A non-object root would make the SDK wrap `structuredContent` as `{ result: … }` for clients
  // on the 2025-era protocol, so it could no longer match the validated canonical result.
  const { type: outputRoot } = outputSchema;

  if (outputRoot !== "object") {
    throw new Error(`Tool "${tool.name}" needs an output schema with an object root.`);
  }

  return {
    name: tool.name,
    description: tool.description,
    // A `ZodObject` always projects to an object root, as the protocol requires of tool inputs.
    inputSchema: { ...projectSchema(tool.inputSchema, "input"), type: "object" },
    outputSchema,
    annotations: projectAnnotations(tool),
  };
}

/**
 * Derives the MCP tool list from the canonical registry, in registry order, with each tool's
 * canonical input and output schemas. Built once at startup; a tool that cannot be described is a
 * programmer error and throws.
 */
export function createMcpToolDescriptors(tools: readonly ToolDefinition[]): readonly Tool[] {
  return tools.map(describeTool);
}
