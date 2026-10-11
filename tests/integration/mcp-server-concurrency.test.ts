import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { calculateTool } from "../../src/tools/calculate/calculate-tool.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { defineTool } from "../../src/tools/tool-definition.js";
import { createFakeNoteStore } from "../helpers/fake-note-store.js";
import { createGatedTool } from "../helpers/gated-tool.js";
import { connectMcp } from "../helpers/mcp-harness.js";
import { rejectionOf } from "../helpers/rejection-of.js";
import { untilAborted } from "../helpers/until-aborted.js";

const BUSY = "server_busy: Too many tool calls are in flight; retry later.";

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

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

function add(a: number, b: number) {
  return { name: "calculate", arguments: { operation: "add", a, b } };
}

describe("concurrent calls", () => {
  it("runs calls at the same time instead of one after another", async () => {
    const gated = createGatedTool();
    const { client, close } = await connectMcp({ tools: [gated.tool] });

    const calls = ["a", "b", "c"].map(async (label) =>
      client.callTool({ name: "gated", arguments: { label } }),
    );

    await gated.whenStarted(3);
    expect([...gated.started].sort()).toEqual(["a", "b", "c"]);

    for (const label of ["c", "b", "a"]) {
      gated.release(label);
    }

    const results = await Promise.all(calls);

    expect(results.map((result) => result.structuredContent)).toEqual([
      { label: "a" },
      { label: "b" },
      { label: "c" },
    ]);
    await close();
  });

  it("gives every concurrent call its own result", async () => {
    const { client, close } = await connectMcp({ tools: [calculateTool] });

    const results = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) => client.callTool(add(index, 100))),
    );

    expect(results.map((result) => result.structuredContent)).toEqual(
      Array.from({ length: 12 }, (_unused, index) => ({ result: index + 100 })),
    );
    await close();
  });

  it("keeps concurrent creates correct: distinct keys make distinct notes, one key makes one", async () => {
    const notes = createFakeNoteStore();
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(notes)] });

    const create = async (text: string, key: string) =>
      client.callTool({ name: "create_note", arguments: { text, idempotencyKey: key } });

    await Promise.all(
      Array.from({ length: 5 }, async (_unused, index) =>
        create(`note ${index}`, `distinct-key-${index}-0000`),
      ),
    );
    expect(notes.notes.size).toBe(5);

    const raced = await Promise.all(
      Array.from({ length: 5 }, async () => create("raced", "shared-key-0000-0000")),
    );

    const created = raced.map((result) =>
      z.object({ created: z.boolean() }).parse(result.structuredContent),
    );

    expect(created.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(notes.notes.size).toBe(6);
    await close();
  });
});

describe("in-flight limit", () => {
  it("refuses calls beyond the limit with server_busy and never reaches the handler for them", async () => {
    const gated = createGatedTool();

    const { client, close } = await connectMcp({
      tools: [gated.tool, calculateTool],
      maxInFlightCalls: 2,
    });

    const first = client.callTool({ name: "gated", arguments: { label: "a" } });
    const second = client.callTool({ name: "gated", arguments: { label: "b" } });

    await gated.whenStarted(2);

    const refusedGated = await client.callTool({ name: "gated", arguments: { label: "c" } });
    const refusedOther = await client.callTool(add(1, 2));

    for (const refused of [refusedGated, refusedOther]) {
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toBe(BUSY);
      expect(refused).not.toHaveProperty("structuredContent");
    }

    expect(gated.started).toEqual(["a", "b"]);

    gated.release("a");
    gated.release("b");
    await Promise.all([first, second]);

    const after = await client.callTool(add(1, 2));

    expect(after.structuredContent).toStrictEqual({ result: 3 });
    await close();
  });

  it("admits exactly the limit from a simultaneous burst, then accepts new calls once they finish", async () => {
    const LIMIT = 4;
    const BURST = 10;
    const gated = createGatedTool();
    const { client, close } = await connectMcp({ tools: [gated.tool], maxInFlightCalls: LIMIT });
    const settled: string[] = [];

    const calls = Array.from({ length: BURST }, async (_unused, index) => {
      const result = await client.callTool({
        name: "gated",
        arguments: { label: `call-${index}` },
      });

      settled.push(result.isError === true ? textOf(result) : "ok");

      return result;
    });

    await gated.whenStarted(LIMIT);
    await vi.waitFor(() => expect(settled).toHaveLength(BURST - LIMIT));
    expect(settled.every((outcome) => outcome === BUSY)).toBe(true);
    expect(gated.started).toHaveLength(LIMIT);

    for (const label of gated.started) {
      gated.release(label);
    }

    await Promise.all(calls);
    expect(settled.filter((outcome) => outcome === "ok")).toHaveLength(LIMIT);

    // Every slot came back: another full set is admitted.
    for (let index = 0; index < LIMIT; index += 1) {
      gated.release(`again-${index}`);
    }

    const again = await Promise.all(
      Array.from({ length: LIMIT }, async (_unused, index) =>
        client.callTool({ name: "gated", arguments: { label: `again-${index}` } }),
      ),
    );

    expect(again.every((result) => result.isError === undefined)).toBe(true);
    await close();
  });

  it("does not consume the caller's idempotency key when it refuses a call", async () => {
    const gated = createGatedTool();
    const notes = createFakeNoteStore();

    const { client, close } = await connectMcp({
      tools: [gated.tool, defineCreateNoteTool(notes)],
      maxInFlightCalls: 1,
    });

    const held = client.callTool({ name: "gated", arguments: { label: "a" } });

    await gated.whenStarted(1);

    const arguments_ = { text: "keep me", idempotencyKey: "retry-after-busy-0001" };
    const refused = await client.callTool({ name: "create_note", arguments: arguments_ });

    expect(textOf(refused)).toBe(BUSY);
    expect(notes.calls.create).toBe(0);

    gated.release("a");
    await held;

    const retried = await client.callTool({ name: "create_note", arguments: arguments_ });

    expect(retried.structuredContent).toMatchObject({ created: true });
    expect(notes.notes.size).toBe(1);
    await close();
  });

  it("frees the slot of a call that timed out", async () => {
    const { client, close } = await connectMcp({
      tools: [hanging, calculateTool],
      maxInFlightCalls: 1,
    });

    const timedOut = await client.callTool({ name: "hanging", arguments: {} });

    expect(textOf(timedOut)).toMatch(/^timed_out: /);
    expect((await client.callTool(add(2, 2))).structuredContent).toStrictEqual({ result: 4 });
    await close();
  });
});

describe("cancellation", () => {
  it("reaches the executor and the handler's signal, and is logged as cancelled", async () => {
    const gated = createGatedTool();
    const { client, logger, close } = await connectMcp({ tools: [gated.tool] });
    const controller = new AbortController();

    const call = client.callTool(
      { name: "gated", arguments: { label: "a" } },
      { signal: controller.signal },
    );

    await gated.whenStarted(1);
    expect(gated.signals.get("a")?.aborted).toBe(false);

    controller.abort();
    await rejectionOf(call);
    await vi.waitFor(() => expect(gated.signals.get("a")?.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: "tool.failed",
          fields: expect.objectContaining({ outcome: "cancelled", toolCallId: "mcp:id-1" }),
        }),
      ),
    );
    await close();
  });

  it("aborts only the cancelled call, leaving a concurrent call running to its result", async () => {
    const gated = createGatedTool();
    const { client, close } = await connectMcp({ tools: [gated.tool] });
    const controller = new AbortController();

    const cancelled = client.callTool(
      { name: "gated", arguments: { label: "a" } },
      { signal: controller.signal },
    );

    const survivor = client.callTool({ name: "gated", arguments: { label: "b" } });

    await gated.whenStarted(2);
    controller.abort();
    await rejectionOf(cancelled);
    await vi.waitFor(() => expect(gated.signals.get("a")?.aborted).toBe(true));
    expect(gated.signals.get("b")?.aborted).toBe(false);

    gated.release("b");
    expect((await survivor).structuredContent).toStrictEqual({ label: "b" });
    expect(gated.finished).toEqual(["b"]);
    await close();
  });

  it("frees the slot of a cancelled call", async () => {
    const gated = createGatedTool();

    const { client, close } = await connectMcp({
      tools: [gated.tool, calculateTool],
      maxInFlightCalls: 1,
    });

    const controller = new AbortController();

    const call = client.callTool(
      { name: "gated", arguments: { label: "a" } },
      { signal: controller.signal },
    );

    await gated.whenStarted(1);
    expect(textOf(await client.callTool(add(1, 1)))).toBe(BUSY);

    controller.abort();
    await rejectionOf(call);

    await vi.waitFor(async () => {
      const probe = await client.callTool(add(1, 1));

      expect(probe.structuredContent).toStrictEqual({ result: 2 });
    });
    await close();
  });
});
