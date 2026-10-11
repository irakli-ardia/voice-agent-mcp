import { describe, expect, it } from "vitest";
import { z } from "zod";
import { err, ok } from "../../src/domain/result.js";
import {
  MAX_TOOL_ERROR_MESSAGE_JSON_BYTES,
  toolErrorMessageJsonBytes,
} from "../../src/domain/tool-execution-error.js";
import { defineTool } from "../../src/tools/tool-definition.js";
import { connectMcp } from "../helpers/mcp-harness.js";

/** `{"t":""}` is eight bytes, so a string of N payload bytes makes a result of N + 8. */
const LIMIT = 100;

const FRAME = 8;

const jsonObject = z.record(z.string(), z.json());

const echoJson = defineTool({
  name: "echo_json",
  description: "Returns the payload it is given.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({ payload: jsonObject.describe("Any JSON object.") }),
  outputSchema: jsonObject,
  failures: {},
  execute: async ({ payload }) => ok(payload),
});

let toJsonCalls = 0;

const strictOutput = defineTool({
  name: "strict_output",
  description: "Returns an object with a serialiser hook and an extra key.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ t: z.string() }),
  failures: {},
  execute: async () => {
    const raw = {
      t: "fine",
      toJSON: (): string => {
        toJsonCalls += 1;

        return "RAW-VALUE-SERIALISED";
      },
    };

    return ok(raw);
  },
});

const LONG_MESSAGE = "m".repeat(MAX_TOOL_ERROR_MESSAGE_JSON_BYTES - 2);

const longFailure = defineTool({
  name: "long_failure",
  description: "Fails with a message exactly at the error cap.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: { too_long: LONG_MESSAGE },
  execute: async () => err("too_long"),
});

const FIELD_NAMES = Array.from(
  { length: 14 },
  (_unused, index) => `field_${index}_${"n".repeat(40)}`,
);

const manyFields = defineTool({
  name: "many_fields",
  description: "Takes many numbers.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject(Object.fromEntries(FIELD_NAMES.map((name) => [name, z.number()]))),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => ok({}),
});

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

async function connect() {
  return connectMcp({
    tools: [echoJson, strictOutput, longFailure, manyFields],
    maxResultBytes: LIMIT,
  });
}

/** Payload strings whose result is `LIMIT + delta` bytes, built from a unit of `unitBytes` bytes. */
const FITS = [
  ["ASCII", "x", 1, 92],
  ["2-byte é", "é", 2, 46],
  ["4-byte emoji", "😀", 4, 23],
  ["newline, escaped to two bytes", "\n", 2, 46],
  ["quote, escaped to two bytes", '"', 2, 46],
  ["control character, escaped to six bytes", "\u0001", 6, 15],
] as const;

describe("result size boundaries", () => {
  describe("at and over the byte limit", () => {
    it.each(FITS)(
      "%s: exactly at the limit passes, in both representations",
      async (_label, unit, unitBytes, count) => {
        const { client, close } = await connect();
        const t = unit.repeat(count);
        const result = await client.callTool({ name: "echo_json", arguments: { payload: { t } } });
        const expectedBytes = FRAME + unitBytes * count;

        expect(result.isError).toBeUndefined();
        expect(expectedBytes).toBeLessThanOrEqual(LIMIT);
        expect(bytes(textOf(result))).toBe(expectedBytes);
        expect(bytes(JSON.stringify(result.structuredContent))).toBe(expectedBytes);
        expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
        expect(result.structuredContent).toStrictEqual({ t });
        await close();
      },
    );

    it.each(FITS)(
      "%s: one more character is refused, with neither representation of it",
      async (_label, unit, _unitBytes, count) => {
        const { client, close } = await connect();
        const t = unit.repeat(count + 1);
        const result = await client.callTool({ name: "echo_json", arguments: { payload: { t } } });

        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe("output_too_large: The tool result is too large to return.");
        expect(result).not.toHaveProperty("structuredContent");
        expect(JSON.stringify(result)).not.toContain(t.slice(0, 20));
        await close();
      },
    );

    it("counts bytes, not characters: fewer characters than the limit can still be too large", async () => {
      const { client, close } = await connect();
      const t = "é".repeat(50);
      const result = await client.callTool({ name: "echo_json", arguments: { payload: { t } } });

      expect(t.length).toBeLessThan(LIMIT - FRAME);
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^output_too_large: /);
      await close();
    });

    it("refuses a result a single byte over the limit even when it is multibyte", async () => {
      const { client, close } = await connect();
      const t = `${"é".repeat(46)}a`;
      const result = await client.callTool({ name: "echo_json", arguments: { payload: { t } } });

      expect(FRAME + bytes(t)).toBe(LIMIT + 1);
      expect(result.isError).toBe(true);
      await close();
    });
  });

  describe("shapes under the limit", () => {
    const PAYLOADS = [
      ["an empty object", {}],
      ["a small flat object", { a: 1, b: "two", c: true, d: null }],
      ["nested objects and arrays", { a: { b: [1, { c: null }, []] }, d: [[[]]] }],
      ["non-ASCII text and keys", { ключ: "значение", 鍵: "値 😀" }],
      ["numbers that JSON writes differently from JavaScript", { a: 1e21, b: -0, c: 0.1 }],
    ] as const;

    it.each(PAYLOADS)(
      "%s: both representations agree and stay within the limit",
      async (_label, payload) => {
        const { client, close } = await connect();
        const result = await client.callTool({ name: "echo_json", arguments: { payload } });

        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        // The in-memory transport hands objects over by reference; a real wire serialises them, so the
        // comparison goes through JSON, as a client reading stdio would see it (-0 is written as 0).
        const onTheWire = JSON.parse(JSON.stringify(result.structuredContent));

        expect(JSON.parse(textOf(result))).toStrictEqual(onTheWire);
        expect(textOf(result)).toBe(JSON.stringify(onTheWire));
        expect(bytes(textOf(result))).toBeLessThanOrEqual(LIMIT);
        await close();
      },
    );
  });

  describe("results the canonical pipeline refuses", () => {
    it("never serialises the handler's raw value before validating it", async () => {
      const { client, close } = await connect();
      const before = toJsonCalls;
      const result = await client.callTool({ name: "strict_output", arguments: {} });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("invalid_output: The tool produced an invalid result.");
      expect(toJsonCalls).toBe(before);
      expect(JSON.stringify(result)).not.toContain("RAW-VALUE");
      await close();
    });
  });

  describe("error messages stay bounded", () => {
    it("a declared failure message exactly at the cap arrives whole and within the cap", async () => {
      const { client, close } = await connect();
      const result = await client.callTool({ name: "long_failure", arguments: {} });
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text).toBe(`execution_failed: ${LONG_MESSAGE}`);
      expect(toolErrorMessageJsonBytes(text.slice("execution_failed: ".length))).toBe(
        MAX_TOOL_ERROR_MESSAGE_JSON_BYTES,
      );
      await close();
    });

    it("an input rejected on many long-named fields is cut to the cap, naming no value", async () => {
      const { client, close } = await connect();
      const args = Object.fromEntries(FIELD_NAMES.map((name) => [name, "NOT-A-NUMBER-VALUE"]));
      const result = await client.callTool({ name: "many_fields", arguments: args });
      const prefix = "invalid_input: ";
      const text = textOf(result);

      expect(result.isError).toBe(true);
      expect(text.startsWith(`${prefix}Invalid arguments: `)).toBe(true);
      expect(toolErrorMessageJsonBytes(text.slice(prefix.length))).toBeLessThanOrEqual(
        MAX_TOOL_ERROR_MESSAGE_JSON_BYTES,
      );
      expect(text).toMatch(/and \d+ more\.$/);
      expect(text).not.toContain("NOT-A-NUMBER-VALUE");
      await close();
    });
  });
});
