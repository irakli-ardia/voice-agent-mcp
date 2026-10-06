import { z } from "zod";
import { err, ok, type Result } from "../../domain/result.js";
import { defineTool } from "../tool-definition.js";

const operationSchema = z.enum(["add", "subtract", "multiply", "divide"]);

type Operation = z.output<typeof operationSchema>;

type CalculateFailure = "division_by_zero" | "out_of_range";

function apply(operation: Operation, a: number, b: number): Result<number, CalculateFailure> {
  switch (operation) {
    case "add":
      return ok(a + b);
    case "subtract":
      return ok(a - b);
    case "multiply":
      return ok(a * b);
    case "divide":
      return b === 0 ? err("division_by_zero") : ok(a / b);
  }
}

export const calculateTool = defineTool({
  name: "calculate",
  description:
    "Performs one arithmetic operation (add, subtract, multiply, or divide) on two numbers and " +
    "returns the result as a double-precision number, which may carry floating-point rounding. " +
    "Use it whenever a request needs arithmetic instead of computing " +
    "the answer yourself. It does not evaluate expressions: split a longer calculation into " +
    "several calls.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({
    operation: operationSchema.describe("The operation to apply: a <operation> b."),
    a: z.number().describe("The first operand."),
    b: z.number().describe("The second operand; the divisor for divide."),
  }),
  outputSchema: z.strictObject({
    result: z.number().describe("The result of the operation."),
  }),
  failures: {
    division_by_zero: "Division by zero is undefined.",
    out_of_range: "The result is too large to represent as a number.",
  },
  execute: async ({ operation, a, b }) => {
    const outcome = apply(operation, a, b);

    if (!outcome.ok) {
      return outcome;
    }

    return Number.isFinite(outcome.value) ? ok({ result: outcome.value }) : err("out_of_range");
  },
});
