import type { Client } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { err, ok } from "../../src/domain/result.js";
import { calculateTool } from "../../src/tools/calculate/calculate-tool.js";
import { defineTool } from "../../src/tools/tool-definition.js";
import { createGatedTool } from "../helpers/gated-tool.js";
import { connectMcp } from "../helpers/mcp-harness.js";
import { untilAborted } from "../helpers/until-aborted.js";

const BUSY = "server_busy: Too many tool calls are in flight; retry later.";

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

const failing = defineTool({
  name: "failing",
  description: "Fails with a declared reason.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: { no_luck: "Declared failure." },
  execute: async () => err("no_luck"),
});

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
    throw new Error("unexpected");
  },
});

const hanging = defineTool({
  name: "hanging",
  description: "Outlives its deadline and honours cancellation.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 20,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async (_input, { signal }) => untilAborted(signal),
});

/** A tool that keeps running after the executor times out, as a write past its deadline does. */
function createStubbornTool() {
  const release = Promise.withResolvers<void>();
  let running = 0;
  let mostRunning = 0;

  const tool = defineTool({
    name: "stubborn",
    description: "Ignores its signal; finishes only when released.",
    risk: "read",
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: 20,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
    failures: {},
    execute: async () => {
      running += 1;
      mostRunning = Math.max(mostRunning, running);

      try {
        await release.promise;
      } finally {
        running -= 1;
      }

      return ok({});
    },
  });

  return {
    tool,
    release: () => release.resolve(),
    running: () => running,
    mostRunning: () => mostRunning,
  };
}

function add(a: number, b: number) {
  return { name: "calculate", arguments: { operation: "add", a, b } };
}

/** Waits until a slot is free again: a cancelled call gives its slot back a moment after the abort. */
async function untilSlotFree(client: Client): Promise<void> {
  await vi.waitFor(async () => {
    expect((await client.callTool(add(1, 1))).structuredContent).toStrictEqual({ result: 2 });
  });
}

describe("in-flight counter invariants", () => {
  it("never lets more handlers run at once than the limit, through a large burst", async () => {
    const LIMIT = 4;
    const gated = createGatedTool();
    const { client, close } = await connectMcp({ tools: [gated.tool], maxInFlightCalls: LIMIT });
    const settled: string[] = [];

    const calls = Array.from({ length: 12 }, async (_unused, index) => {
      const result = await client.callTool({ name: "gated", arguments: { label: `b${index}` } });

      settled.push(result.isError === true ? textOf(result) : "ok");
    });

    await gated.whenStarted(LIMIT);
    await vi.waitFor(() => expect(settled).toHaveLength(12 - LIMIT));

    for (const label of gated.started) {
      gated.release(label);
    }

    await Promise.all(calls);
    expect(gated.peak()).toBe(LIMIT);
    expect(gated.started).toHaveLength(LIMIT);
    expect(settled.filter((outcome) => outcome === BUSY)).toHaveLength(12 - LIMIT);
    await close();
  });

  it("stays exact through rounds of success, failure, throw, timeout and cancellation", async () => {
    const LIMIT = 3;
    const gated = createGatedTool();

    const { client, close } = await connectMcp({
      tools: [gated.tool, failing, throwing, hanging, calculateTool],
      maxInFlightCalls: LIMIT,
    });

    for (let round = 0; round < 3; round += 1) {
      const labels = Array.from({ length: LIMIT }, (_unused, index) => `r${round}-${index}`);
      const controllers = labels.map(() => new AbortController());

      const calls = labels.map(async (label, index) =>
        client.callTool(
          { name: "gated", arguments: { label } },
          { signal: controllers[index]?.signal ?? new AbortController().signal },
        ),
      );

      const settledCalls = Promise.allSettled(calls);

      await gated.whenStarted((round + 1) * LIMIT);
      controllers[0]?.abort();

      for (const label of labels.slice(1)) {
        gated.release(label);
      }

      await settledCalls;
      await untilSlotFree(client);

      expect((await client.callTool({ name: "failing", arguments: {} })).isError).toBe(true);
      expect((await client.callTool({ name: "throwing", arguments: {} })).isError).toBe(true);
      expect(textOf(await client.callTool({ name: "hanging", arguments: {} }))).toMatch(
        /^timed_out/,
      );
    }

    // After nine abnormal endings the count is still exact: neither leaked nor negative.
    const before = gated.started.length;
    const BURST = LIMIT + 4;
    const refused: string[] = [];

    const burst = Array.from({ length: BURST }, async (_unused, index) => {
      const result = await client.callTool({
        name: "gated",
        arguments: { label: `final-${index}` },
      });

      if (result.isError === true) {
        refused.push(textOf(result));
      }
    });

    await vi.waitFor(() => expect(gated.started.length - before).toBe(LIMIT));
    await vi.waitFor(() => expect(refused).toHaveLength(BURST - LIMIT));
    expect(refused.every((text) => text === BUSY)).toBe(true);
    expect(gated.peak()).toBeLessThanOrEqual(LIMIT);

    for (const label of gated.started) {
      gated.release(label);
    }

    await Promise.all(burst);
    await close();
  });

  it("refuses repeated immediate rejections without reaching a handler or disturbing the count", async () => {
    const gated = createGatedTool();

    const { client, close } = await connectMcp({
      tools: [gated.tool, calculateTool],
      maxInFlightCalls: 1,
    });

    const held = client.callTool({ name: "gated", arguments: { label: "held" } });

    await gated.whenStarted(1);

    const refused = await Promise.all(
      Array.from({ length: 200 }, async () =>
        client.callTool({ name: "gated", arguments: { label: "extra" } }),
      ),
    );

    expect(refused.every((result) => result.isError === true && textOf(result) === BUSY)).toBe(
      true,
    );
    expect(gated.started).toEqual(["held"]);

    gated.release("held");
    await held;
    expect((await client.callTool(add(2, 3))).structuredContent).toStrictEqual({ result: 5 });

    const again = client.callTool({ name: "gated", arguments: { label: "again" } });

    await gated.whenStarted(2);
    expect(textOf(await client.callTool(add(1, 1)))).toBe(BUSY);
    gated.release("again");
    await again;
    await close();
  });

  it("does not let one failed call disturb a concurrent one", async () => {
    const gated = createGatedTool();
    const { client, close } = await connectMcp({ tools: [gated.tool, failing, throwing] });
    const survivor = client.callTool({ name: "gated", arguments: { label: "a" } });

    await gated.whenStarted(1);
    expect((await client.callTool({ name: "failing", arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: "throwing", arguments: {} })).isError).toBe(true);
    expect(gated.signals.get("a")?.aborted).toBe(false);

    gated.release("a");
    expect((await survivor).structuredContent).toStrictEqual({ label: "a" });
    await close();
  });
});

describe("what the in-flight limit bounds", () => {
  // A: MCP requests being handled. B: executor waits (the executor stops waiting at a deadline or
  // an abort). C: tool handlers still running. The limit counts A, and A and B end together; C can
  // outlive both, so the limit does not bound the handlers actually running.

  it("frees the slot when the caller cancels, though the handler is still running (C outlives A and B)", async () => {
    const gated = createGatedTool({ honorsSignal: false });

    const { client, close } = await connectMcp({
      tools: [gated.tool, calculateTool],
      maxInFlightCalls: 1,
    });

    const controller = new AbortController();

    const cancelled = client.callTool(
      { name: "gated", arguments: { label: "a" } },
      { signal: controller.signal },
    );

    await gated.whenStarted(1);
    expect(textOf(await client.callTool(add(1, 1)))).toBe(BUSY);

    controller.abort();
    await cancelled.catch(() => undefined);
    await untilSlotFree(client);

    // The slot is free, yet the first handler is still running: a second one now starts beside it.
    const second = client.callTool({ name: "gated", arguments: { label: "b" } });

    await gated.whenStarted(2);
    expect(gated.active()).toBe(2);
    expect(gated.peak()).toBe(2);

    gated.release("a");
    gated.release("b");
    await second;
    await vi.waitFor(() => expect(gated.active()).toBe(0));
    await close();
  });

  it("frees the slot at the executor's deadline, though the handler keeps running", async () => {
    const stubborn = createStubbornTool();
    const { client, close } = await connectMcp({ tools: [stubborn.tool], maxInFlightCalls: 1 });

    expect(textOf(await client.callTool({ name: "stubborn", arguments: {} }))).toMatch(
      /^timed_out/,
    );
    expect(stubborn.running()).toBe(1);

    expect(textOf(await client.callTool({ name: "stubborn", arguments: {} }))).toMatch(
      /^timed_out/,
    );
    expect(stubborn.running()).toBe(2);
    expect(stubborn.mostRunning()).toBe(2);

    stubborn.release();
    await vi.waitFor(() => expect(stubborn.running()).toBe(0));
    await close();
  });
});
