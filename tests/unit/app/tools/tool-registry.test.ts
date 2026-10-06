import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolRegistry } from "../../../../src/app/tools/tool-registry.js";
import { ok } from "../../../../src/domain/result.js";
import { defineTool, type ToolDefinition } from "../../../../src/tools/tool-definition.js";

const echoTool = defineTool({
  name: "echo",
  description: "Echoes its text.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({ text: z.string().max(10) }),
  outputSchema: z.strictObject({ text: z.string() }),
  failures: {},
  execute: async ({ text }) => ok({ text }),
});

function renamed(name: string): ToolDefinition {
  return { ...echoTool, name };
}

function withTimeout(timeoutMs: number): ToolDefinition {
  return { ...echoTool, timeoutMs };
}

describe("createToolRegistry", () => {
  it("finds a tool by its exact name and lists tools in registration order", () => {
    const other = renamed("other_tool");
    const registry = createToolRegistry([echoTool, other]);

    expect(registry.find("echo")).toBe(echoTool);
    expect(registry.find("other_tool")).toBe(other);
    expect(registry.tools).toEqual([echoTool, other]);
  });

  it.each([
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "ECHO",
    "Echo",
    " echo",
    "echo ",
    "echo\u0000",
    "",
    "e".repeat(10_000),
  ])("does not resolve %j", (name) => {
    expect(createToolRegistry([echoTool]).find(name)).toBeUndefined();
  });

  it("is not affected by later changes to the array it was built from", () => {
    const tools = [echoTool];
    const registry = createToolRegistry(tools);
    tools.push(renamed("late_tool"));

    expect(registry.tools).toEqual([echoTool]);
    expect(registry.find("late_tool")).toBeUndefined();
  });

  it("rejects a duplicate name and names it", () => {
    expect(() => createToolRegistry([echoTool, renamed("echo")])).toThrow(
      'Tool name "echo" is registered more than once.',
    );
  });

  it.each(["Echo", "1echo", "echo-tool", "echo tool", "_echo", "", "e".repeat(65)])(
    "rejects the invalid name %j",
    (name) => {
      expect(() => createToolRegistry([renamed(name)])).toThrow(/must be snake_case/);
    },
  );

  it("accepts a 64-character name", () => {
    expect(() => createToolRegistry([renamed("e".repeat(64))])).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "rejects the timeout %d",
    (timeoutMs) => {
      expect(() => createToolRegistry([withTimeout(timeoutMs)])).toThrow(/integer timeoutMs/);
    },
  );

  it.each([1, 2_147_483_647])("accepts the timeout %d", (timeoutMs) => {
    expect(() => createToolRegistry([withTimeout(timeoutMs)])).not.toThrow();
  });
});

describe("createToolRegistry: idempotency contract", () => {
  const KEY = z
    .string()
    .min(16)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/);

  function keyed(inputSchema: z.ZodObject, idempotency: "none" | "key" = "key"): ToolDefinition {
    return { ...echoTool, risk: "write", idempotency, inputSchema };
  }

  it("accepts a key tool whose required key field accepts a host-derived key", () => {
    expect(() =>
      createToolRegistry([keyed(z.strictObject({ text: z.string(), idempotencyKey: KEY }))]),
    ).not.toThrow();
  });

  it.each([
    ["no key field", z.strictObject({ text: z.string() })],
    ["an optional key", z.strictObject({ idempotencyKey: KEY.optional() })],
    ["a nullable key", z.strictObject({ idempotencyKey: KEY.nullable() })],
    ["a numeric key", z.strictObject({ idempotencyKey: z.number() })],
    [
      "a key too short for a host-derived key",
      z.strictObject({ idempotencyKey: z.string().max(20) }),
    ],
  ])("rejects a key tool with %s", (_kind, inputSchema) => {
    expect(() => createToolRegistry([keyed(inputSchema)])).toThrow(/declares idempotency "key"/);
  });

  it("rejects a tool that takes an idempotencyKey but declares idempotency none", () => {
    expect(() =>
      createToolRegistry([keyed(z.strictObject({ idempotencyKey: KEY }), "none")]),
    ).toThrow(/takes an idempotencyKey but declares idempotency "none"/);
  });
});

describe("createToolRegistry: failure message bound", () => {
  function withMessage(message: string): ToolDefinition {
    return { ...echoTool, failures: [{ reason: "bad", message }] };
  }

  /** 1024 serialised bytes: 1022 characters plus the two quotes JSON adds. */
  it("accepts a message whose serialised JSON is exactly 1024 bytes", () => {
    expect(() => createToolRegistry([withMessage("a".repeat(1_022))])).not.toThrow();
  });

  it.each([
    ["1025 serialised ASCII bytes", "a".repeat(1_023)],
    ["multi-byte characters (342 × 3 bytes)", "€".repeat(342)],
    ["characters JSON escapes (171 × 6 bytes)", "\u0001".repeat(171)],
  ])("rejects a message of %s", (_kind, message) => {
    expect(() => createToolRegistry([withMessage(message)])).toThrow(/over 1024 serialised bytes/);
  });

  it("measures bytes, not characters: 340 euro signs fit", () => {
    expect(() => createToolRegistry([withMessage("€".repeat(340))])).not.toThrow();
  });
});
