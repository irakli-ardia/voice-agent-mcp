import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { mapToolResult } from "../../../../src/adapters/mcp/mcp-result-mapper.js";
import type { JsonObject } from "../../../../src/domain/json-value.js";
import { err, ok } from "../../../../src/domain/result.js";
import type { ToolErrorCode } from "../../../../src/domain/tool-execution-error.js";

const NESTED_OUTPUT: JsonObject = {
  text: 'naïve   "quoted" \n 😀',
  count: 3,
  ratio: 0.1,
  flag: false,
  nothing: null,
  list: [1, "two", { three: 3 }],
  nested: { deeper: { deepest: [] } },
};

const FAILURES = [
  ["invalid_input", "Invalid arguments: a: Invalid input."],
  ["confirmation_required", "This tool requires confirmation from the user, which was not given."],
  ["cancelled", "The tool call was cancelled; its outcome is unknown."],
  ["timed_out", "The tool did not finish within its time limit; its outcome is unknown."],
  ["execution_failed", "A declared, static failure message."],
  ["internal_error", "The tool failed unexpectedly."],
  ["invalid_output", "The tool produced an invalid result."],
  ["output_too_large", "The tool result is too large to return."],
  ["server_busy", "Too many tool calls are in flight; retry later."],
] as const satisfies readonly (readonly [ToolErrorCode | "server_busy", string])[];

describe("mapToolResult", () => {
  describe("success", () => {
    it("returns the validated object as structuredContent", () => {
      expect(mapToolResult(ok(NESTED_OUTPUT)).structuredContent).toStrictEqual(NESTED_OUTPUT);
    });

    it("returns exactly one text block holding JSON.stringify of that same object", () => {
      const mapped = mapToolResult(ok(NESTED_OUTPUT));

      expect(mapped.content).toStrictEqual([{ type: "text", text: JSON.stringify(NESTED_OUTPUT) }]);
    });

    it("keeps the two representations in agreement for every value kind", () => {
      const mapped = mapToolResult(ok(NESTED_OUTPUT));
      const [block] = mapped.content;

      expect(block?.type).toBe("text");
      expect(JSON.parse(block?.type === "text" ? block.text : "")).toStrictEqual(
        mapped.structuredContent,
      );
    });

    it("handles an empty object", () => {
      const mapped = mapToolResult(ok({}));

      expect(mapped.structuredContent).toStrictEqual({});
      expect(mapped.content).toStrictEqual([{ type: "text", text: "{}" }]);
    });

    it("does not mark a success as an error", () => {
      expect(mapToolResult(ok({})).isError).toBeUndefined();
    });
  });

  describe("tool execution errors", () => {
    it.each(FAILURES)("%s: isError with one '<code>: <message>' text block", (code, message) => {
      expect(mapToolResult(err({ code, message }))).toStrictEqual({
        isError: true,
        content: [{ type: "text", text: `${code}: ${message}` }],
      });
    });

    it.each(FAILURES)("%s: carries no structuredContent", (code, message) => {
      expect(mapToolResult(err({ code, message }))).not.toHaveProperty("structuredContent");
    });
  });

  describe("unknown tool", () => {
    const failure = { code: "unknown_tool", message: "No tool with this name exists." };

    it("is a JSON-RPC invalid-params protocol error with the static message", () => {
      let thrown: unknown;

      try {
        mapToolResult(err(failure));
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ProtocolError);
      expect(thrown).toMatchObject({
        code: ProtocolErrorCode.InvalidParams,
        message: "No tool with this name exists.",
      });
      expect(ProtocolErrorCode.InvalidParams).toBe(-32602);
    });
  });
});
