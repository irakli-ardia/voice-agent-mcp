import { describe, expect, it } from "vitest";
import { calculateTool } from "../../../../src/tools/calculate/calculate-tool.js";
import { runTool } from "../../../helpers/run-tool.js";

describe("calculateTool", () => {
  it.each([
    ["add", 2, 3, 5],
    ["subtract", 2, 3, -1],
    ["multiply", 2.5, 4, 10],
    ["divide", 7, 2, 3.5],
    ["divide", -0, 5, -0],
  ])("%s(%d, %d) = %d", async (operation, a, b, result) => {
    expect(await runTool(calculateTool, { arguments: { operation, a, b } })).toEqual({
      ok: true,
      value: { result },
    });
  });

  it("reports division by zero as an expected failure", async () => {
    expect(
      await runTool(calculateTool, { arguments: { operation: "divide", a: 1, b: 0 } }),
    ).toEqual({
      ok: false,
      error: { code: "execution_failed", message: "Division by zero is undefined." },
    });
  });

  it.each([
    ["multiply", Number.MAX_VALUE, 2],
    ["add", Number.MAX_VALUE, Number.MAX_VALUE],
    ["subtract", -Number.MAX_VALUE, Number.MAX_VALUE],
    ["divide", Number.MAX_VALUE, 0.5],
  ])("reports overflow of %s as out of range", async (operation, a, b) => {
    expect(await runTool(calculateTool, { arguments: { operation, a, b } })).toEqual({
      ok: false,
      error: {
        code: "execution_failed",
        message: "The result is too large to represent as a number.",
      },
    });
  });

  it.each([
    ["an unknown operation", { operation: "power", a: 2, b: 3 }],
    ["an expression", { operation: "add", a: "1+1", b: 3 }],
    ["a missing operand", { operation: "add", a: 1 }],
    ["an extra key", { operation: "add", a: 1, b: 2, c: 3 }],
    ["a non-finite operand", { operation: "add", a: Number.POSITIVE_INFINITY, b: 1 }],
  ])("rejects %s", async (_label, args) => {
    const result = await runTool(calculateTool, { arguments: args });

    expect(result.ok ? "ok" : result.error.code).toBe("invalid_input");
  });
});
