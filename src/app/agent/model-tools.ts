import { z } from "zod";
import type { JsonObject, JsonValue } from "../../domain/json-value.js";
import type { ModelTool } from "../../ports/agent-model.js";
import type { ToolDefinition } from "../../tools/tool-definition.js";

const jsonObjectSchema = z.record(z.string(), z.json());

const objectNodeSchema = z.looseObject({ type: z.literal("object") });

/**
 * An object node of a strict function schema: closed, and every property required. Zod omits
 * `properties` and `required` when there are none, which strict mode accepts.
 */
const strictObjectNodeSchema = z.looseObject({
  additionalProperties: z.literal(false),
  properties: z.record(z.string(), z.json()).default({}),
  required: z.array(z.string()).default([]),
});

function isJsonObject(value: JsonValue): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

/** Every object node, at any depth, must satisfy strict function-schema rules. */
function isStrictCompatible(node: JsonValue): boolean {
  if (Array.isArray(node)) {
    return node.every(isStrictCompatible);
  }

  if (!isJsonObject(node)) {
    return true;
  }

  if (objectNodeSchema.safeParse(node).success) {
    const parsed = strictObjectNodeSchema.safeParse(node);

    if (!parsed.success) {
      return false;
    }

    const properties = Object.keys(parsed.data.properties).sort();
    const required = [...new Set(parsed.data.required)].sort();

    if (properties.join("\u0000") !== required.join("\u0000")) {
      return false;
    }
  }

  return Object.values(node).every(isStrictCompatible);
}

/**
 * The model-facing JSON Schema of one tool. A `key` tool's `idempotencyKey` is host-owned, so it
 * is omitted on a new schema; the canonical schema is never mutated and stays what the executor
 * validates against.
 */
function projectParameters(tool: ToolDefinition): JsonObject {
  const schema =
    tool.idempotency === "key" ? tool.inputSchema.omit({ idempotencyKey: true }) : tool.inputSchema;

  const projected = jsonObjectSchema.parse(z.toJSONSchema(schema, { io: "input" }));

  const parameters = Object.fromEntries(
    Object.entries(projected).filter(([keyword]) => keyword !== "$schema"),
  );

  if (!isStrictCompatible(parameters)) {
    throw new Error(`Tool "${tool.name}" has an input schema that is not strict-compatible.`);
  }

  return parameters;
}

/**
 * Derives the tools the model sees from the canonical registry, in registry order. Built once at
 * startup; a schema that cannot be projected is a programmer error and throws.
 */
export function createModelTools(tools: readonly ToolDefinition[]): readonly ModelTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: projectParameters(tool),
  }));
}
