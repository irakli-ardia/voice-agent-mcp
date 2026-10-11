import { isSpecType as isClientSpecType } from "@modelcontextprotocol/client";
import { isSpecType, type ToolAnnotations } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMcpToolDescriptors } from "../../../../src/adapters/mcp/mcp-tool-descriptors.js";
import { createApplication } from "../../../../src/bootstrap/create-application.js";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from "../../../../src/domain/note.js";
import { ok } from "../../../../src/domain/result.js";
import { defineTool, type ToolDefinition } from "../../../../src/tools/tool-definition.js";
import { testConfig } from "../../../helpers/test-config.js";

const { tools } = createApplication(
  testConfig({ dataDir: "mcp-descriptor-test-data-dir-never-written" }),
);

const registered = tools.tools;

const descriptors = createMcpToolDescriptors(registered);

const closedObjectSchema = z.looseObject({
  type: z.literal("object"),
  additionalProperties: z.literal(false),
  properties: z.record(z.string(), z.looseObject({})),
  required: z.array(z.string()),
});

const keySchema = z.looseObject({
  type: z.literal("string"),
  minLength: z.number(),
  maxLength: z.number(),
  pattern: z.string(),
});

const KEY_FIELD = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(IDEMPOTENCY_KEY_PATTERN);

const NO_OUTPUT = z.strictObject({});

function requireTool(name: string): ToolDefinition {
  const tool = registered.find((candidate) => candidate.name === name);

  if (tool === undefined) {
    throw new Error(`Tool "${name}" is not registered.`);
  }

  return tool;
}

function descriptorOf(name: string): (typeof descriptors)[number] {
  const descriptor = descriptors.find((candidate) => candidate.name === name);

  if (descriptor === undefined) {
    throw new Error(`No descriptor for "${name}".`);
  }

  return descriptor;
}

type JsonSchema = z.core.JSONSchema.BaseSchema;

function withoutSchemaKeyword(schema: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([keyword]) => keyword !== "$schema"));
}

function keylessTool(name: string, risk: "read" | "write" | "external"): ToolDefinition {
  return defineTool({
    name,
    description: "Keyless.",
    risk,
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: 1_000,
    inputSchema: z.strictObject({ value: z.string().max(5).describe("A value.") }),
    outputSchema: NO_OUTPUT,
    failures: {},
    execute: async () => ok({}),
  });
}

function keyedTool(name: string, risk: "write" | "external"): ToolDefinition {
  return defineTool({
    name,
    description: "Keyed.",
    risk,
    requiresConfirmation: false,
    idempotency: "key",
    timeoutMs: 1_000,
    inputSchema: z.strictObject({ idempotencyKey: KEY_FIELD }),
    outputSchema: NO_OUTPUT,
    failures: {},
    execute: async () => ok({}),
  });
}

const destructiveKeyless = defineTool({
  name: "destructive_keyless",
  description: "Destroys.",
  risk: "destructive",
  requiresConfirmation: true,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({ value: z.string().max(5).describe("A value.") }),
  outputSchema: NO_OUTPUT,
  failures: {},
  execute: async () => ok({}),
});

const destructiveKeyed = defineTool({
  name: "destructive_keyed",
  description: "Destroys once per key.",
  risk: "destructive",
  requiresConfirmation: true,
  idempotency: "key",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({ idempotencyKey: KEY_FIELD }),
  outputSchema: NO_OUTPUT,
  failures: {},
  execute: async () => ok({}),
});

describe("MCP tool descriptors", () => {
  it("describes every registered tool exactly once, in registry order", () => {
    expect(descriptors.map((descriptor) => descriptor.name)).toEqual(
      registered.map((tool) => tool.name),
    );
    expect(registered.length).toBeGreaterThan(0);
  });

  it("keeps registration order instead of sorting", () => {
    const listed = createMcpToolDescriptors([
      keylessTool("zeta", "read"),
      keylessTool("alpha", "read"),
      keylessTool("mid", "read"),
    ]);

    expect(listed.map((descriptor) => descriptor.name)).toEqual(["zeta", "alpha", "mid"]);
  });

  it("is deterministic across calls", () => {
    expect(createMcpToolDescriptors(registered)).toStrictEqual(descriptors);
  });

  it.each(registered.map((tool) => [tool.name, tool] as const))(
    "%s: copies name and description from the canonical definition",
    (_name, tool) => {
      const descriptor = descriptorOf(tool.name);

      expect(descriptor.name).toBe(tool.name);
      expect(descriptor.description).toBe(tool.description);
    },
  );
});

describe("MCP tool descriptor schemas", () => {
  it.each(registered.map((tool) => [tool.name, tool] as const))(
    "%s: input and output schemas are Zod's own JSON Schema, minus $schema",
    (_name, tool) => {
      const descriptor = descriptorOf(tool.name);

      expect(descriptor.inputSchema).toStrictEqual(
        withoutSchemaKeyword(z.toJSONSchema(tool.inputSchema, { io: "input" })),
      );
      expect(descriptor.outputSchema).toStrictEqual(
        withoutSchemaKeyword(z.toJSONSchema(tool.outputSchema, { io: "output" })),
      );
    },
  );

  it.each(registered.map((tool) => [tool.name, tool] as const))(
    "%s: schemas are closed objects whose properties are exactly the canonical fields, all required",
    (_name, tool) => {
      const descriptor = descriptorOf(tool.name);
      const input = closedObjectSchema.parse(descriptor.inputSchema);
      const output = closedObjectSchema.parse(descriptor.outputSchema);
      const inputKeys = Object.keys(tool.inputSchema.shape).sort();

      expect(Object.keys(input.properties).sort()).toEqual(inputKeys);
      expect([...input.required].sort()).toEqual(inputKeys);
      expect([...output.required].sort()).toEqual(Object.keys(output.properties).sort());
      expect(descriptor.inputSchema).not.toHaveProperty("$schema");
      expect(descriptor.outputSchema).not.toHaveProperty("$schema");
    },
  );

  it.each(registered.map((tool) => [tool.name, tool] as const))(
    "%s: is a valid MCP tool for the SDK and survives JSON serialisation unchanged",
    (_name, tool) => {
      const descriptor = descriptorOf(tool.name);

      expect(isSpecType.Tool(descriptor)).toBe(true);
      expect(JSON.parse(JSON.stringify(descriptor))).toStrictEqual(descriptor);
    },
  );

  it("is accepted as a tools/list result by the MCP client package", () => {
    expect(isClientSpecType.ListToolsResult({ tools: descriptors })).toBe(true);
    expect(isClientSpecType.ListToolsResult({ tools: [{ name: "x", inputSchema: {} }] })).toBe(
      false,
    );
  });

  it("exposes idempotencyKey as a required, bounded field on exactly the keyed tools", () => {
    for (const tool of registered) {
      const input = closedObjectSchema.parse(descriptorOf(tool.name).inputSchema);

      const exposed =
        Object.hasOwn(input.properties, "idempotencyKey") &&
        input.required.includes("idempotencyKey");

      expect(exposed).toBe(tool.idempotency === "key");
    }

    const createNote = closedObjectSchema.parse(descriptorOf("create_note").inputSchema);
    const { idempotencyKey } = createNote.properties;
    const key = keySchema.parse(idempotencyKey);

    expect(key.minLength).toBe(IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(key.maxLength).toBe(IDEMPOTENCY_KEY_MAX_LENGTH);
    expect(key.pattern).toBe(IDEMPOTENCY_KEY_PATTERN.source);
  });

  it("leaves the canonical schemas untouched", () => {
    const createNote = requireTool("create_note");
    const before = Object.keys(createNote.inputSchema.shape);

    createMcpToolDescriptors(registered);

    expect(Object.keys(createNote.inputSchema.shape)).toEqual(before);
    expect(before).toContain("idempotencyKey");
  });

  it("fails at startup when an output schema has no object root", () => {
    const unionOutput = defineTool({
      name: "union_output",
      description: "Either shape.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs: 1_000,
      inputSchema: z.strictObject({}),
      outputSchema: z.union([z.strictObject({ a: z.string() }), z.strictObject({ b: z.string() })]),
      failures: {},
      execute: async () => ok({ a: "x" }),
    });

    expect(() => createMcpToolDescriptors([unionOutput])).toThrow(
      'Tool "union_output" needs an output schema with an object root.',
    );
  });

  it("fails at startup when a schema cannot be expressed as JSON Schema", () => {
    const transformed = defineTool({
      name: "transformed_output",
      description: "Transforms.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs: 1_000,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ a: z.string() }).transform((value) => value),
      failures: {},
      execute: async () => ok({ a: "x" }),
    });

    expect(() => createMcpToolDescriptors([transformed])).toThrow(/cannot be represented/i);
  });
});

describe("MCP tool annotations", () => {
  const readOnly: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

  it.each([
    ["get_current_time", readOnly],
    ["calculate", readOnly],
    ["read_note", readOnly],
    [
      "create_note",
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ],
  ] as const)("%s: real tool annotations", (name, expected) => {
    expect(descriptorOf(name).annotations).toStrictEqual(expected);
  });

  it.each([
    ["read, keyless", keylessTool("read_keyless", "read"), readOnly],
    [
      "write, keyed: additive and repeat-safe",
      keyedTool("write_keyed", "write"),
      { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ],
    [
      "write, keyless: repeats are not promised safe",
      keylessTool("write_keyless", "write"),
      { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    ],
    [
      "destructive, keyless",
      destructiveKeyless,
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    ],
    [
      "destructive, keyed",
      destructiveKeyed,
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    ],
    [
      "external, keyless: conservative destructive, open world",
      keylessTool("external_keyless", "external"),
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    ],
    [
      "external, keyed",
      keyedTool("external_keyed", "external"),
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    ],
  ] as const)("%s", (_label, tool, expected) => {
    const [descriptor] = createMcpToolDescriptors([tool]);

    expect(descriptor?.annotations).toStrictEqual(expected);
  });

  it("derives every hint from risk and idempotency, never from the tool's name", () => {
    const [named] = createMcpToolDescriptors([keylessTool("idempotent_destructive_write", "read")]);

    expect(named?.annotations).toStrictEqual(readOnly);
  });
});
