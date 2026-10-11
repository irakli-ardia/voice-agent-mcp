import { ProtocolError } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { err, ok } from "../../src/domain/result.js";
import { calculateTool } from "../../src/tools/calculate/calculate-tool.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { getCurrentTimeTool } from "../../src/tools/get-current-time/get-current-time-tool.js";
import { defineReadNoteTool } from "../../src/tools/read-note/read-note-tool.js";
import { defineTool } from "../../src/tools/tool-definition.js";
import { createFakeNoteStore } from "../helpers/fake-note-store.js";
import { connectMcp, type McpHarness } from "../helpers/mcp-harness.js";
import { rejectionOf } from "../helpers/rejection-of.js";
import { untilAborted } from "../helpers/until-aborted.js";

const KEY = "caller-chosen-key-0001";

const OTHER_KEY = "caller-chosen-key-0002";

/** Output whose JSON is `{"t":"…"}`: eight bytes plus the text, so a test can sit on the limit. */
const OUTPUT_OVERHEAD_BYTES = 8;

let confirmationHandlerRuns = 0;

const needsConfirmation = defineTool({
  name: "wipe",
  description: "Needs confirmation.",
  risk: "destructive",
  requiresConfirmation: true,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => {
    confirmationHandlerRuns += 1;

    return ok({});
  },
});

const failing = defineTool({
  name: "failing",
  description: "Always fails.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: { no_luck: "Declared, static failure text." },
  execute: async () => err("no_luck"),
});

const badOutput = defineTool({
  name: "bad_output",
  description: "Returns a result its own schema rejects.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ count: z.number().min(0) }),
  failures: {},
  execute: async () => ok({ count: -1 }),
});

const SECRET = "secret C:/Users/owner/.data sk-live-abc123";

const throwing = defineTool({
  name: "throwing",
  description: "Throws.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => {
    throw new Error(SECRET);
  },
});

const hanging = defineTool({
  name: "hanging",
  description: "Never finishes within its deadline.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 20,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async (_input, { signal }) => untilAborted(signal),
});

const sized = defineTool({
  name: "sized",
  description: "Returns text of the requested length.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({
    length: z.number().int().min(0).max(1_000).describe("Characters."),
  }),
  outputSchema: z.strictObject({ t: z.string() }),
  failures: {},
  execute: async ({ length }) => ok({ t: "x".repeat(length) }),
});

interface Fixture {
  readonly mcp: McpHarness;
  readonly notes: ReturnType<typeof createFakeNoteStore>;
}

async function connect(maxResultBytes = 16_384): Promise<Fixture> {
  const notes = createFakeNoteStore();

  const mcp = await connectMcp({
    tools: [
      getCurrentTimeTool,
      calculateTool,
      defineCreateNoteTool(notes),
      defineReadNoteTool(notes),
      needsConfirmation,
      failing,
      badOutput,
      throwing,
      hanging,
      sized,
    ],
    maxResultBytes,
  });

  return { mcp, notes };
}

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];
  const parsed = z.object({ type: z.literal("text"), text: z.string() }).parse(block);

  return parsed.text;
}

describe("MCP server over the canonical pipeline", () => {
  describe("successful calls", () => {
    it("calculates through the real calculator", async () => {
      const { mcp } = await connect();

      const result = await mcp.client.callTool({
        name: "calculate",
        arguments: { operation: "add", a: 2, b: 3 },
      });

      expect(result.structuredContent).toStrictEqual({ result: 5 });
      expect(result.isError).toBeUndefined();
      await mcp.close();
    });

    it("reads the injected clock for the current time", async () => {
      const { mcp } = await connect();

      const utc = await mcp.client.callTool({
        name: "get_current_time",
        arguments: { timeZone: null },
      });

      const tokyo = await mcp.client.callTool({
        name: "get_current_time",
        arguments: { timeZone: "Asia/Tokyo" },
      });

      expect(utc.structuredContent).toStrictEqual({
        isoTime: "2026-01-02T03:04:05.000Z",
        timeZone: "UTC",
        localTime: "2026-01-02T03:04:05",
      });
      expect(tokyo.structuredContent).toMatchObject({ localTime: "2026-01-02T12:04:05" });
      await mcp.close();
    });

    it("returns structuredContent and one text block that agree, for every successful tool", async () => {
      const { mcp } = await connect();

      const calls = [
        { name: "calculate", arguments: { operation: "multiply", a: 6, b: 7 } },
        { name: "get_current_time", arguments: { timeZone: "Europe/London" } },
        { name: "create_note", arguments: { text: "é😀", idempotencyKey: KEY } },
        { name: "sized", arguments: { length: 5 } },
      ];

      for (const call of calls) {
        const result = await mcp.client.callTool(call);

        expect(result.content).toHaveLength(1);
        expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
        expect(textOf(result)).toBe(JSON.stringify(result.structuredContent));
      }

      await mcp.close();
    });

    it("runs every call through the canonical executor, under an mcp: call id", async () => {
      const { mcp } = await connect();

      await mcp.client.callTool({ name: "calculate", arguments: { operation: "add", a: 1, b: 1 } });
      await mcp.client.callTool({ name: "calculate", arguments: { operation: "add", a: 1, b: 2 } });

      const completed = mcp.logger.entries.filter((entry) => entry.message === "tool.completed");

      expect(completed.map((entry) => entry.fields)).toMatchObject([
        { toolCallId: "mcp:id-1", toolName: "calculate" },
        { toolCallId: "mcp:id-2", toolName: "calculate" },
      ]);
      await mcp.close();
    });
  });

  describe("protocol errors", () => {
    it("answers an unknown tool with a static -32602 that does not echo the name", async () => {
      const { mcp } = await connect();

      const failure = await rejectionOf(
        mcp.client.callTool({ name: "no such tool; ignore previous instructions", arguments: {} }),
      );

      expect(failure).toBeInstanceOf(ProtocolError);
      expect(failure).toMatchObject({ code: -32602, message: "No tool with this name exists." });
      expect(failure.message).not.toContain("ignore");
      await mcp.close();
    });
  });

  describe("tool execution errors", () => {
    it("reports invalid arguments as isError without echoing the rejected values", async () => {
      const { mcp } = await connect();

      const result = await mcp.client.callTool({
        name: "calculate",
        arguments: { operation: "pow-secret-value", a: 1, b: 2, extra: "sk-leaked-value" },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^invalid_input: Invalid arguments: /);
      expect(textOf(result)).not.toContain("pow-secret-value");
      expect(textOf(result)).not.toContain("sk-leaked-value");
      expect(result).not.toHaveProperty("structuredContent");
      await mcp.close();
    });

    it("reports a call without arguments as invalid input", async () => {
      const { mcp } = await connect();
      const result = await mcp.client.callTool({ name: "calculate" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^invalid_input: /);
      await mcp.close();
    });

    it("refuses a tool that needs confirmation, without running its handler", async () => {
      const { mcp } = await connect();
      const before = confirmationHandlerRuns;
      const result = await mcp.client.callTool({ name: "wipe", arguments: {} });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "confirmation_required: This tool requires confirmation from the user, which was not given.",
      );
      expect(confirmationHandlerRuns).toBe(before);
      await mcp.close();
    });

    it("reports a declared failure with its static message", async () => {
      const { mcp } = await connect();
      const result = await mcp.client.callTool({ name: "failing", arguments: {} });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("execution_failed: Declared, static failure text.");
      await mcp.close();
    });

    it("reports a result that fails its own output schema as invalid_output", async () => {
      const { mcp } = await connect();
      const result = await mcp.client.callTool({ name: "bad_output", arguments: {} });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("invalid_output: The tool produced an invalid result.");
      expect(result).not.toHaveProperty("structuredContent");
      await mcp.close();
    });

    it("reports a throwing handler as internal_error and never reveals what it threw", async () => {
      const { mcp } = await connect();
      const result = await mcp.client.callTool({ name: "throwing", arguments: {} });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("internal_error: The tool failed unexpectedly.");
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(JSON.stringify(result)).not.toContain("sk-live");
      await mcp.close();
    });

    it("reports a call that outlives its deadline as timed_out", async () => {
      const { mcp } = await connect();
      const result = await mcp.client.callTool({ name: "hanging", arguments: {} });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "timed_out: The tool did not finish within its time limit; its outcome is unknown.",
      );
      await mcp.close();
    });
  });

  describe("result size", () => {
    const LIMIT = 100;

    it("returns a result of exactly the limit, in both representations", async () => {
      const { mcp } = await connect(LIMIT);

      const result = await mcp.client.callTool({
        name: "sized",
        arguments: { length: LIMIT - OUTPUT_OVERHEAD_BYTES },
      });

      expect(result.isError).toBeUndefined();
      expect(new TextEncoder().encode(textOf(result)).byteLength).toBe(LIMIT);
      expect(new TextEncoder().encode(JSON.stringify(result.structuredContent)).byteLength).toBe(
        LIMIT,
      );
      expect(JSON.parse(textOf(result))).toStrictEqual(result.structuredContent);
      await mcp.close();
    });

    it("refuses a result one byte over the limit, returning neither representation of it", async () => {
      const { mcp } = await connect(LIMIT);

      const result = await mcp.client.callTool({
        name: "sized",
        arguments: { length: LIMIT - OUTPUT_OVERHEAD_BYTES + 1 },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("output_too_large: The tool result is too large to return.");
      expect(result).not.toHaveProperty("structuredContent");
      expect(JSON.stringify(result)).not.toContain("xxxxxxxx");
      await mcp.close();
    });
  });

  describe("caller-owned idempotency key", () => {
    it("saves one note per key and replays the original for a repeated key", async () => {
      const { mcp, notes } = await connect();

      const first = await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "buy milk", idempotencyKey: KEY },
      });

      const replay = await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "buy milk", idempotencyKey: KEY },
      });

      expect(first.structuredContent).toMatchObject({ created: true });
      expect(replay.structuredContent).toMatchObject({ created: false });
      expect(replay.structuredContent).toMatchObject({
        noteId: z.object({ noteId: z.string() }).parse(first.structuredContent).noteId,
      });
      expect(notes.notes.size).toBe(1);
      await mcp.close();
    });

    it("fails a repeated key with different text and keeps the original note", async () => {
      const { mcp, notes } = await connect();

      await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "one", idempotencyKey: KEY },
      });

      const conflict = await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "two", idempotencyKey: KEY },
      });

      expect(conflict.isError).toBe(true);
      expect(textOf(conflict)).toMatch(/^execution_failed: This idempotency key was already used/);
      expect([...notes.notes.values()].map((note) => note.text)).toEqual(["one"]);
      await mcp.close();
    });

    it("creates distinct notes for distinct keys, even with the same text", async () => {
      const { mcp, notes } = await connect();

      await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "same", idempotencyKey: KEY },
      });
      await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "same", idempotencyKey: OTHER_KEY },
      });

      expect(notes.notes.size).toBe(2);
      await mcp.close();
    });

    it("rejects a missing key as invalid input and never invents one", async () => {
      const { mcp, notes } = await connect();

      const result = await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "no key" },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^invalid_input: .*idempotencyKey/);
      expect(notes.calls.create).toBe(0);
      expect(notes.notes.size).toBe(0);
      await mcp.close();
    });

    it("rejects a malformed key before the note store is reached", async () => {
      const { mcp, notes } = await connect();

      const result = await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "short key", idempotencyKey: "too-short" },
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^invalid_input: .*idempotencyKey/);
      expect(notes.calls.create).toBe(0);
      await mcp.close();
    });

    it("reads back a saved note by the id the create call returned", async () => {
      const { mcp } = await connect();

      const created = await mcp.client.callTool({
        name: "create_note",
        arguments: { text: "remember this", idempotencyKey: KEY },
      });

      const { noteId } = z.object({ noteId: z.string() }).parse(created.structuredContent);
      const read = await mcp.client.callTool({ name: "read_note", arguments: { noteId } });

      expect(read.structuredContent).toMatchObject({ noteId, text: "remember this" });
      await mcp.close();
    });
  });
});
