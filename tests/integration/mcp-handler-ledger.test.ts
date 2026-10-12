import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHandlerLedger } from "../../src/app/tools/handler-ledger.js";
import { createGatedTool } from "../helpers/gated-tool.js";
import { connectMcp } from "../helpers/mcp-harness.js";

const OVERLOADED = "overloaded: Too many earlier tool calls are still running; retry later.";

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

/** A tool that ignores its signal and a 20 ms deadline, so a held call is abandoned quickly. */
function stuckTool() {
  return createGatedTool({ honorsSignal: false, timeoutMs: 20 });
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  expect(condition()).toBe(true);
}

describe("the handler ledger over MCP", () => {
  it("refuses a call as overloaded once three handlers were abandoned, before any handler runs", async () => {
    const gated = stuckTool();
    const ledger = createHandlerLedger({ maxAbandoned: 3 });
    const { client, close } = await connectMcp({ tools: [gated.tool], handlerLedger: ledger });

    for (const label of ["a", "b", "c"]) {
      const result = await client.callTool({ name: "gated", arguments: { label } });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^timed_out: /);
    }

    expect(ledger.counts()).toEqual({ unsettled: 3, abandoned: 3 });

    const refused = await client.callTool({ name: "gated", arguments: { label: "d" } });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(OVERLOADED);
    expect(refused.structuredContent).toBeUndefined();
    expect(gated.started).toEqual(["a", "b", "c"]);

    await close();
  });

  it("recovers when an abandoned handler really settles", async () => {
    const gated = stuckTool();
    const ledger = createHandlerLedger({ maxAbandoned: 1 });
    const { client, close } = await connectMcp({ tools: [gated.tool], handlerLedger: ledger });

    await client.callTool({ name: "gated", arguments: { label: "a" } });

    expect(textOf(await client.callTool({ name: "gated", arguments: { label: "b" } }))).toBe(
      OVERLOADED,
    );

    gated.release("a");
    await waitUntil(() => ledger.counts().unsettled === 0);

    const next = client.callTool({ name: "gated", arguments: { label: "c" } });

    await gated.whenStarted(2);
    gated.release("c");

    expect((await next).structuredContent).toEqual({ label: "c" });
    await close();
  });

  it("counts a different resource than the in-flight limit", async () => {
    const gated = stuckTool();
    const ledger = createHandlerLedger({ maxAbandoned: 1 });

    const { client, close } = await connectMcp({
      tools: [gated.tool],
      handlerLedger: ledger,
      maxInFlightCalls: 1,
    });

    await client.callTool({ name: "gated", arguments: { label: "a" } });

    // The abandoned handler holds no in-flight slot, so the next call reaches the executor and
    // is refused there, not by the in-flight limit.
    expect(textOf(await client.callTool({ name: "gated", arguments: { label: "b" } }))).toBe(
      OVERLOADED,
    );

    await close();
  });

  it("keeps the in-flight limit for calls that are being waited on", async () => {
    const gated = createGatedTool();
    const ledger = createHandlerLedger({ maxAbandoned: 3 });

    const { client, close } = await connectMcp({
      tools: [gated.tool],
      handlerLedger: ledger,
      maxInFlightCalls: 1,
    });

    const held = client.callTool({ name: "gated", arguments: { label: "a" } });

    await gated.whenStarted(1);

    const busy = await client.callTool({ name: "gated", arguments: { label: "b" } });

    expect(textOf(busy)).toBe("server_busy: Too many tool calls are in flight; retry later.");
    expect(ledger.counts()).toEqual({ unsettled: 1, abandoned: 0 });

    gated.release("a");
    await held;
    await close();
  });

  it("abandons a handler when the client cancels the request, and clears it when it settles", async () => {
    const gated = createGatedTool({ honorsSignal: false });
    const ledger = createHandlerLedger({ maxAbandoned: 3 });
    const { client, close } = await connectMcp({ tools: [gated.tool], handlerLedger: ledger });
    const cancel = new AbortController();

    const pending = client
      .callTool({ name: "gated", arguments: { label: "a" } }, { signal: cancel.signal })
      .catch(() => "cancelled");

    await gated.whenStarted(1);
    cancel.abort();

    expect(await pending).toBe("cancelled");
    await waitUntil(() => ledger.counts().abandoned === 1);

    gated.release("a");
    await waitUntil(() => ledger.counts().unsettled === 0);

    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    await close();
  });
});
