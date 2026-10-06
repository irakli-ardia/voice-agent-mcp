import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createModelTools } from "../../../../src/app/agent/model-tools.js";
import { ok } from "../../../../src/domain/result.js";
import { defineTool, type ToolDefinition } from "../../../../src/tools/tool-definition.js";

const KEY_SCHEMA = z
  .string()
  .min(16)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe("The key.");

const saveTool = defineTool({
  name: "save",
  description: "Saves text.",
  risk: "write",
  requiresConfirmation: false,
  idempotency: "key",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({
    text: z.string().min(1).max(10).describe("The text."),
    idempotencyKey: KEY_SCHEMA,
  }),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => ok({}),
});

const lookupTool = defineTool({
  name: "lookup",
  description: "Looks a value up.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({
    id: z.string().max(5).describe("The id."),
    zone: z.string().max(5).nullable().describe("The zone."),
  }),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => ok({}),
});

function withSchema(inputSchema: z.ZodObject): ToolDefinition {
  return { ...lookupTool, inputSchema };
}

describe("createModelTools", () => {
  it("keeps registry order, names, and descriptions", () => {
    expect(
      createModelTools([saveTool, lookupTool]).map(({ name, description }) => [name, description]),
    ).toEqual([
      ["save", "Saves text."],
      ["lookup", "Looks a value up."],
    ]);
  });

  it("omits the host-owned idempotencyKey from a key tool's parameters", () => {
    const [save] = createModelTools([saveTool]);

    expect(save?.parameters).toEqual({
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 10, description: "The text." },
      },
      required: ["text"],
      additionalProperties: false,
    });
    expect(JSON.stringify(save)).not.toContain("idempotencyKey");
  });

  it("never mutates the canonical schema, which still requires the key", () => {
    createModelTools([saveTool]);

    expect(Object.keys(saveTool.inputSchema.shape)).toEqual(["text", "idempotencyKey"]);
    expect(saveTool.inputSchema.safeParse({ text: "a" }).success).toBe(false);
    expect(
      saveTool.inputSchema.safeParse({ text: "a", idempotencyKey: "k".repeat(16) }).success,
    ).toBe(true);
  });

  it("projects a tool without a key unchanged, minus the $schema keyword", () => {
    const [lookup] = createModelTools([lookupTool]);

    const { $schema: _dialect, ...expected } = z.toJSONSchema(lookupTool.inputSchema, {
      io: "input",
    });

    expect(lookup?.parameters).toEqual(expected);
    expect(lookup?.parameters).not.toHaveProperty("$schema");
  });

  it.each([
    ["an open object", z.object({ id: z.string().max(5).describe("Id.") })],
    ["an optional property", z.strictObject({ id: z.string().max(5).optional().describe("Id.") })],
    [
      "an open nested object",
      z.strictObject({ inner: z.object({ id: z.string().max(5) }).describe("Inner.") }),
    ],
    [
      "an optional nested property",
      z.strictObject({ inner: z.strictObject({ id: z.string().optional() }).describe("Inner.") }),
    ],
  ])("refuses at startup a schema with %s", (_kind, schema) => {
    expect(() => createModelTools([withSchema(schema)])).toThrow(/not strict-compatible/);
  });

  it("accepts a strict object without properties", () => {
    expect(createModelTools([withSchema(z.strictObject({}))])[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("accepts nested strict objects", () => {
    const nested = z.strictObject({
      inner: z.strictObject({ id: z.string().max(5) }).describe("Inner."),
    });

    expect(() => createModelTools([withSchema(nested)])).not.toThrow();
  });
});
