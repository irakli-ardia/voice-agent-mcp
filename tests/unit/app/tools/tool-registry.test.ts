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
