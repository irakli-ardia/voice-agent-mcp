import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHandlerLedger } from "../../src/app/tools/handler-ledger.js";
import { createGatedTool, type GatedTool } from "../helpers/gated-tool.js";
import { connectMcp } from "../helpers/mcp-harness.js";

/**
 * S2 question: does the MCP in-flight cap, beside the abandoned-handler limit of S1, bound ALL
 * unsettled handlers, or does an abandoned-only limit leave a gap? These tests drive storms
 * through the real executor, ledger, and server with handlers that ignore their signal.
 */

const IN_FLIGHT = 16;

const ABANDONED_LIMIT = 3;

/** Admission lets at most `IN_FLIGHT` active handlers in while fewer than the limit are abandoned. */
const UNSETTLED_BOUND = ABANDONED_LIMIT - 1 + IN_FLIGHT;

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

function stuckTool(): GatedTool {
  return createGatedTool({ honorsSignal: false, timeoutMs: 20 });
}

async function waitUntil(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  expect(condition()).toBe(true);
}

async function connect(gated: GatedTool) {
  const ledger = createHandlerLedger({ maxAbandoned: ABANDONED_LIMIT });
  const connection = await connectMcp({ tools: [gated.tool], handlerLedger: ledger });

  const call = async (label: string) =>
    connection.client.callTool({ name: "gated", arguments: { label } });

  return { ...connection, ledger, call };
}

describe("active and abandoned handlers over MCP", () => {
  it("bounds a timeout storm by the in-flight cap, then refuses everything until handlers settle", async () => {
    const gated = stuckTool();
    const { ledger, call, close } = await connect(gated);

    const storm = await Promise.all(Array.from({ length: 40 }, async (_, i) => call(`s${i}`)));
    const texts = storm.map(textOf);

    expect(texts.filter((text) => text.startsWith("timed_out"))).toHaveLength(IN_FLIGHT);
    expect(texts.filter((text) => text.startsWith("server_busy"))).toHaveLength(40 - IN_FLIGHT);
    expect(gated.peak()).toBeLessThanOrEqual(UNSETTLED_BOUND);
    expect(ledger.counts()).toEqual({ unsettled: IN_FLIGHT, abandoned: IN_FLIGHT });

    // The abandoned limit is now exceeded: a second storm never reaches a handler.
    const second = await Promise.all(Array.from({ length: 40 }, async (_, i) => call(`t${i}`)));

    expect(
      second
        .map(textOf)
        .every((text) => text.startsWith("overloaded") || text.startsWith("server_busy")),
    ).toBe(true);
    expect(gated.started).toHaveLength(IN_FLIGHT);
    expect(gated.peak()).toBeLessThanOrEqual(UNSETTLED_BOUND);

    await close();
  });

  it("recovers step by step as the underlying handlers settle", async () => {
    const gated = stuckTool();
    const { ledger, call, close } = await connect(gated);

    await Promise.all(Array.from({ length: IN_FLIGHT }, async (_, i) => call(`s${i}`)));

    // 14 of 16 settle: two are abandoned, below the limit of three, so calls are admitted again.
    for (let index = 0; index < IN_FLIGHT - 2; index += 1) {
      gated.release(`s${index}`);
    }

    await waitUntil(() => ledger.counts().abandoned === 2);

    const admitted = call("after");

    await gated.whenStarted(IN_FLIGHT + 1);
    gated.release("after");

    expect((await admitted).structuredContent).toEqual({ label: "after" });

    for (const label of [`s${IN_FLIGHT - 2}`, `s${IN_FLIGHT - 1}`]) {
      gated.release(label);
    }

    await waitUntil(() => ledger.counts().unsettled === 0);
    await close();
  });

  it("bounds a cancellation storm the same way", async () => {
    const gated = createGatedTool({ honorsSignal: false });
    const ledger = createHandlerLedger({ maxAbandoned: ABANDONED_LIMIT });
    const { client, close } = await connectMcp({ tools: [gated.tool], handlerLedger: ledger });

    const controllers = Array.from({ length: IN_FLIGHT }, () => new AbortController());

    const calls = controllers.map(async (controller, index) =>
      client
        .callTool(
          { name: "gated", arguments: { label: `c${index}` } },
          { signal: controller.signal },
        )
        .catch(() => "cancelled"),
    );

    await gated.whenStarted(IN_FLIGHT);

    for (const controller of controllers) {
      controller.abort();
    }

    expect(await Promise.all(calls)).toEqual(Array(IN_FLIGHT).fill("cancelled"));
    await waitUntil(() => ledger.counts().abandoned === IN_FLIGHT);

    const refused = await client.callTool({ name: "gated", arguments: { label: "next" } });

    expect(textOf(refused)).toMatch(/^overloaded: /);
    expect(gated.started).toHaveLength(IN_FLIGHT);
    expect(gated.peak()).toBeLessThanOrEqual(UNSETTLED_BOUND);

    for (let index = 0; index < IN_FLIGHT; index += 1) {
      gated.release(`c${index}`);
    }

    await waitUntil(() => ledger.counts().unsettled === 0);
    await close();
  });

  it("keeps sequential timeouts at the abandoned limit: later requests never start a handler", async () => {
    const gated = stuckTool();
    const { ledger, call, close } = await connect(gated);

    const texts: string[] = [];

    for (let index = 0; index < 20; index += 1) {
      texts.push(textOf(await call(`q${index}`)));
    }

    expect(texts.filter((text) => text.startsWith("timed_out"))).toHaveLength(ABANDONED_LIMIT);
    expect(texts.slice(ABANDONED_LIMIT).every((text) => text.startsWith("overloaded"))).toBe(true);
    expect(gated.started).toHaveLength(ABANDONED_LIMIT);
    expect(ledger.counts()).toEqual({ unsettled: ABANDONED_LIMIT, abandoned: ABANDONED_LIMIT });

    for (let index = 0; index < ABANDONED_LIMIT; index += 1) {
      gated.release(`q${index}`);
    }

    await waitUntil(() => ledger.counts().unsettled === 0);

    // Fully recovered: the next call is served normally.
    const next = call("fresh");

    await gated.whenStarted(ABANDONED_LIMIT + 1);
    gated.release("fresh");

    expect((await next).structuredContent).toEqual({ label: "fresh" });
    await close();
  });

  it("holds the bound over repeated storms and recoveries", async () => {
    const gated = stuckTool();
    const { ledger, call, close } = await connect(gated);

    for (let round = 0; round < 5; round += 1) {
      const labels = Array.from({ length: 20 }, (_, i) => `r${round}-${i}`);

      await Promise.all(labels.map(call));

      for (const label of gated.started) {
        gated.release(label);
      }

      await waitUntil(() => ledger.counts().unsettled === 0);
    }

    expect(gated.peak()).toBeLessThanOrEqual(UNSETTLED_BOUND);
    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    await close();
  });
});
