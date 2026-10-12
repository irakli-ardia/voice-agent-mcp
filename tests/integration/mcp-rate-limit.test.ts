import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createCallAdmission } from "../../src/adapters/mcp/call-admission.js";
import { createMcpServer } from "../../src/adapters/mcp/create-mcp-server.js";
import type { ToolExecutor } from "../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../src/app/tools/tool-registry.js";
import { ok } from "../../src/domain/result.js";
import { calculateTool } from "../../src/tools/calculate/calculate-tool.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../helpers/fake-id-generator.js";
import { createGatedTool } from "../helpers/gated-tool.js";
import { connectClient, connectMcp } from "../helpers/mcp-harness.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";
import { rejectionOf } from "../helpers/rejection-of.js";

const RATE_LIMITED = "rate_limited: Too many tool calls; retry after a short delay.";

const BUSY = "server_busy: Too many tool calls are in flight; retry later.";

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

const add = { name: "calculate", arguments: { operation: "add", a: 1, b: 2 } };

function countingExecutor() {
  let calls = 0;

  return {
    calls: () => calls,
    executeTool: (async () => {
      calls += 1;

      return ok({ result: 3 });
    }) satisfies ToolExecutor,
  };
}

describe("MCP rate limit", () => {
  it("refuses the call after the burst with a static rate_limited result, before the executor", async () => {
    const { executeTool, calls } = countingExecutor();

    const { client, close } = await connectMcp({
      tools: [calculateTool],
      executeTool,
      maxCallsPerSecond: 2,
    });

    expect((await client.callTool(add)).isError).toBeUndefined();
    expect((await client.callTool(add)).isError).toBeUndefined();

    const refused = await client.callTool(add);

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(RATE_LIMITED);
    expect(refused.structuredContent).toBeUndefined();
    expect(calls()).toBe(2);
    await close();
  });

  it("admits calls again as the clock refills the bucket", async () => {
    const clock = createFakeClock();

    const { client, close } = await connectMcp({
      tools: [calculateTool],
      clock,
      maxCallsPerSecond: 2,
    });

    await client.callTool(add);
    await client.callTool(add);

    expect(textOf(await client.callTool(add))).toBe(RATE_LIMITED);

    clock.advance(499);

    expect(textOf(await client.callTool(add))).toBe(RATE_LIMITED);

    clock.advance(1);

    expect((await client.callTool(add)).structuredContent).toStrictEqual({ result: 3 });
    expect(textOf(await client.callTool(add))).toBe(RATE_LIMITED);
    await close();
  });

  it("never limits tools/list or the protocol around it", async () => {
    const { client, close } = await connectMcp({ tools: [calculateTool], maxCallsPerSecond: 1 });

    await client.callTool(add);

    for (let index = 0; index < 50; index += 1) {
      expect((await client.listTools()).tools).toHaveLength(1);
    }

    await close();
  });

  it("answers an over-limit call to an unknown tool as rate_limited, never echoing the name", async () => {
    const { client, close } = await connectMcp({ tools: [calculateTool], maxCallsPerSecond: 1 });

    await client.callTool(add);

    const refused = await client.callTool({ name: "SECRET_TOOL_NAME", arguments: {} });

    expect(textOf(refused)).toBe(RATE_LIMITED);
    expect(JSON.stringify(refused)).not.toContain("SECRET_TOOL_NAME");
    await close();
  });

  it("still reports an unknown tool inside the burst as the JSON-RPC error it always was", async () => {
    const { client, close } = await connectMcp({ tools: [calculateTool], maxCallsPerSecond: 5 });

    expect(await rejectionOf(client.callTool({ name: "missing", arguments: {} }))).toMatchObject({
      code: -32602,
    });
    await close();
  });

  it("logs a refusal as counts only: no arguments, tool names, or ids", async () => {
    const { client, close, logger } = await connectMcp({
      tools: [calculateTool],
      maxCallsPerSecond: 1,
    });

    await client.callTool(add);
    await client.callTool({
      name: "calculate",
      arguments: { operation: "SECRET_ARGUMENT", a: "SECRET_VALUE", b: 0 },
    });

    const limited = logger.entries.filter((entry) => entry.message === "mcp.rate_limited");

    expect(limited).toEqual([
      { level: "warn", message: "mcp.rate_limited", fields: { refused: 1, callsPerSecond: 1 } },
    ]);
    expect(JSON.stringify(logger.entries)).not.toMatch(/SECRET/);
    await close();
  });

  it("consumes a token for a call the in-flight cap refuses", async () => {
    const gated = createGatedTool();

    const { client, close } = await connectMcp({
      tools: [gated.tool],
      maxInFlightCalls: 1,
      maxCallsPerSecond: 3,
    });

    const held = client.callTool({ name: "gated", arguments: { label: "a" } });

    await gated.whenStarted(1);

    expect(textOf(await client.callTool({ name: "gated", arguments: { label: "b" } }))).toBe(BUSY);
    expect(textOf(await client.callTool({ name: "gated", arguments: { label: "c" } }))).toBe(BUSY);

    // Three tokens, three requests: the fourth finds none, whatever the in-flight cap says.
    expect(textOf(await client.callTool({ name: "gated", arguments: { label: "d" } }))).toBe(
      RATE_LIMITED,
    );

    gated.release("a");
    await held;
    await close();
  });

  it("charges a call that is cancelled, and still frees its in-flight slot", async () => {
    const gated = createGatedTool();

    const { client, close } = await connectMcp({
      tools: [gated.tool],
      maxInFlightCalls: 1,
      maxCallsPerSecond: 3,
    });

    const cancel = new AbortController();

    const cancelled = client
      .callTool({ name: "gated", arguments: { label: "a" } }, { signal: cancel.signal })
      .catch(() => "cancelled");

    await gated.whenStarted(1);
    cancel.abort();

    expect(await cancelled).toBe("cancelled");

    // The slot is free again (these are not busy) and the cancelled call already paid a token.
    await vi.waitFor(async () => {
      const next = client.callTool({ name: "gated", arguments: { label: "b" } });

      await gated.whenStarted(2);
      gated.release("b");
      expect((await next).isError).toBeUndefined();
    });

    const third = client.callTool({ name: "gated", arguments: { label: "c" } });

    await gated.whenStarted(3);
    gated.release("c");
    await third;

    expect(textOf(await client.callTool({ name: "gated", arguments: { label: "d" } }))).toBe(
      RATE_LIMITED,
    );
    await close();
  });

  it("does not take a slot or start a handler for a refused call", async () => {
    const gated = createGatedTool();
    const { client, close } = await connectMcp({ tools: [gated.tool], maxCallsPerSecond: 1 });

    const first = client.callTool({ name: "gated", arguments: { label: "a" } });

    await gated.whenStarted(1);

    expect(textOf(await client.callTool({ name: "gated", arguments: { label: "b" } }))).toBe(
      RATE_LIMITED,
    );
    expect(gated.started).toEqual(["a"]);

    gated.release("a");
    await first;
    await close();
  });

  it("runs the same calls the same way whatever the rate, when the rate is not exceeded", async () => {
    const { client, close } = await connectMcp({
      tools: [calculateTool],
      maxCallsPerSecond: 20,
      maxInFlightCalls: 20,
    });

    const results = await Promise.all(Array.from({ length: 20 }, async () => client.callTool(add)));

    expect(results.every((result) => result.isError === undefined)).toBe(true);
    await close();
  });
});

describe("MCP rate limit: one bucket per process", () => {
  it("is shared by every server built over the same admission", async () => {
    const { executeTool, calls } = countingExecutor();
    const registry = createToolRegistry([calculateTool]);

    const admission = createCallAdmission({
      clock: createFakeClock(),
      logger: createRecordingLogger(),
      maxCallsPerSecond: 2,
      maxInFlightCalls: 16,
    });

    // The SDK may build more than one server for a connection; they must not each get a bucket.
    const build = () =>
      createMcpServer({
        serverInfo: { name: "test", version: "0" },
        tools: registry,
        executeTool,
        ids: createFakeIdGenerator("id"),
        admission,
      });

    const first = await connectClient(build());
    const second = await connectClient(build());

    expect((await first.client.callTool(add)).isError).toBeUndefined();
    expect((await second.client.callTool(add)).isError).toBeUndefined();
    expect(textOf(await first.client.callTool(add))).toBe(RATE_LIMITED);
    expect(textOf(await second.client.callTool(add))).toBe(RATE_LIMITED);
    expect(calls()).toBe(2);
    await first.close();
    await second.close();
  });
});

describe("MCP shutdown refusal", () => {
  it("refuses a call after admission is closed with a static server_shutting_down result, before the executor", async () => {
    const { executeTool, calls } = countingExecutor();
    const clock = createFakeClock();
    const logger = createRecordingLogger();

    const admission = createCallAdmission({
      clock,
      logger,
      maxCallsPerSecond: 20,
      maxInFlightCalls: 16,
    });

    const { client, close } = await connectMcp({ tools: [calculateTool], executeTool, admission });

    expect((await client.callTool(add)).isError).toBeUndefined();

    admission.close();

    const refused = await client.callTool(add);

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      "server_shutting_down: The server is shutting down; this call was not run.",
    );
    expect(refused.structuredContent).toBeUndefined();
    expect(calls()).toBe(1);
    await close();
  });
});
