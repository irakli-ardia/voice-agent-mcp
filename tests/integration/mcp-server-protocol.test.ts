import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ok } from "../../src/domain/result.js";
import { calculateTool } from "../../src/tools/calculate/calculate-tool.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { defineTool } from "../../src/tools/tool-definition.js";
import { createCommitGate } from "../helpers/commit-gate.js";
import { createFakeNoteStore } from "../helpers/fake-note-store.js";
import { createGatedTool } from "../helpers/gated-tool.js";
import { connectRawMcp } from "../helpers/mcp-raw-peer.js";

describe("cancellation at the protocol level", () => {
  it("sends no response for a cancelled request, although a handler that ignores its signal still finishes", async () => {
    const gated = createGatedTool({ honorsSignal: false });
    const peer = await connectRawMcp({ tools: [gated.tool] });

    await peer.request(5, "tools/call", { name: "gated", arguments: { label: "a" } });
    await gated.whenStarted(1);
    await peer.notify("notifications/cancelled", { requestId: 5, reason: "user cancelled" });
    await vi.waitFor(() => expect(gated.signals.get("a")?.aborted).toBe(true));

    gated.release("a");
    await vi.waitFor(() => expect(gated.finished).toEqual(["a"]));
    await peer.settle();

    expect(peer.responsesTo(5)).toEqual([]);
    expect(gated.finished).toEqual(["a"]);
    await peer.close();
  });

  it("answers a request normally when the cancel arrives after the response", async () => {
    const peer = await connectRawMcp({ tools: [calculateTool] });

    await peer.request(6, "tools/call", {
      name: "calculate",
      arguments: { operation: "add", a: 1, b: 2 },
    });
    await peer.whenResponse(6);
    await peer.notify("notifications/cancelled", { requestId: 6 });
    await peer.settle();

    expect(peer.responsesTo(6)).toHaveLength(1);
    await peer.close();
  });

  it("ignores a cancel for a request that does not exist, and keeps serving", async () => {
    const peer = await connectRawMcp({ tools: [calculateTool] });

    await peer.notify("notifications/cancelled", { requestId: 999 });
    await peer.request(7, "tools/call", {
      name: "calculate",
      arguments: { operation: "add", a: 2, b: 2 },
    });

    expect(await peer.whenResponse(7)).toMatchObject({ id: 7 });
    await peer.close();
  });
});

describe("duplicate in-flight JSON-RPC request ids", () => {
  // The SDK exposes no public hook to refuse a second request that reuses an id still in flight:
  // it dispatches both. These tests pin that behaviour so a change in the SDK is noticed.

  it("executes both requests", async () => {
    const gated = createGatedTool();
    const peer = await connectRawMcp({ tools: [gated.tool] });

    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "first" } });
    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "second" } });
    await gated.whenStarted(2);

    expect([...gated.started].sort()).toEqual(["first", "second"]);

    gated.release("first");
    gated.release("second");
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(2));
    await peer.close();
  });

  it("answers each with the same id, so the client cannot tell the two results apart", async () => {
    const gated = createGatedTool();
    const peer = await connectRawMcp({ tools: [gated.tool] });

    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "first" } });
    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "second" } });
    await gated.whenStarted(2);
    gated.release("second");
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(1));
    gated.release("first");
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(2));

    const labels = peer.responsesTo(9).map((response) => JSON.stringify(response));

    expect(labels[0]).toContain("second");
    expect(labels[1]).toContain("first");
    await peer.close();
  });

  it("lets a cancel for the shared id reach only one of them", async () => {
    const gated = createGatedTool();
    const peer = await connectRawMcp({ tools: [gated.tool] });

    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "first" } });
    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "second" } });
    await gated.whenStarted(2);
    await peer.notify("notifications/cancelled", { requestId: 9 });
    await vi.waitFor(() =>
      expect([gated.signals.get("first")?.aborted, gated.signals.get("second")?.aborted]).toContain(
        true,
      ),
    );
    await peer.settle();

    const aborted = ["first", "second"].filter((label) => gated.signals.get(label)?.aborted);

    expect(aborted).toEqual(["second"]);
    await peer.close();
  });
});

describe("duplicate in-flight ids do not bypass the canonical pipeline", () => {
  // Reusing an id is a client error the SDK does not stop (see above). What matters is that each
  // request still passes validation, idempotency, the in-flight limit, and the output bound.

  const resultSchema = z.object({
    result: z.object({
      isError: z.boolean().optional(),
      content: z.array(z.object({ text: z.string() })),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
    }),
  });

  const BUSY = "server_busy: Too many tool calls are in flight; retry later.";

  function outcomes(peer: Awaited<ReturnType<typeof connectRawMcp>>, id: number) {
    return peer.responsesTo(id).map((response) => resultSchema.parse(response).result);
  }

  it("validates each request: both are rejected as invalid input", async () => {
    const peer = await connectRawMcp({ tools: [calculateTool] });
    const call = { name: "calculate", arguments: { operation: "nope", a: 1, b: 2 } };

    await peer.request(9, "tools/call", call);
    await peer.request(9, "tools/call", call);
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(2));

    for (const outcome of outcomes(peer, 9)) {
      expect(outcome.isError).toBe(true);
      expect(outcome.content[0]?.text).toMatch(/^invalid_input: /);
    }

    await peer.close();
  });

  it("keeps a keyed write to one effect when the same key arrives under a reused id", async () => {
    const gate = createCommitGate();
    const notes = createFakeNoteStore({ beforeCommit: gate.beforeCommit });
    const peer = await connectRawMcp({ tools: [defineCreateNoteTool(notes)] });

    const call = {
      name: "create_note",
      arguments: { text: "once", idempotencyKey: "reused-id-key-000001" },
    };

    await peer.request(9, "tools/call", call);
    await peer.request(9, "tools/call", call);
    await gate.whenEntered(2);
    gate.release(0);
    gate.release(1);
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(2));

    const created = outcomes(peer, 9).map(({ structuredContent }) => {
      const { created } = structuredContent ?? {};

      return created;
    });

    expect(created.filter((value) => value === true)).toHaveLength(1);
    expect(notes.notes.size).toBe(1);
    await peer.close();
  });

  it("counts each against the in-flight limit: the second is refused, not run", async () => {
    const gated = createGatedTool();
    const peer = await connectRawMcp({ tools: [gated.tool], maxInFlightCalls: 1 });

    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "first" } });
    await gated.whenStarted(1);
    await peer.request(9, "tools/call", { name: "gated", arguments: { label: "second" } });
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(1));

    expect(outcomes(peer, 9)[0]?.content[0]?.text).toBe(BUSY);
    expect(gated.started).toEqual(["first"]);

    gated.release("first");
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(2));
    await peer.close();
  });

  it("applies the output bound to each: both oversized results are refused", async () => {
    const oversized = defineTool({
      name: "oversized",
      description: "Returns more than the limit.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs: 1_000,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ t: z.string() }),
      failures: {},
      execute: async () => ok({ t: "x".repeat(500) }),
    });

    const peer = await connectRawMcp({ tools: [oversized], maxResultBytes: 100 });

    await peer.request(9, "tools/call", { name: "oversized", arguments: {} });
    await peer.request(9, "tools/call", { name: "oversized", arguments: {} });
    await vi.waitFor(() => expect(peer.responsesTo(9)).toHaveLength(2));

    for (const outcome of outcomes(peer, 9)) {
      expect(outcome.isError).toBe(true);
      expect(outcome.content[0]?.text).toMatch(/^output_too_large: /);
      expect(outcome.structuredContent).toBeUndefined();
    }

    await peer.close();
  });
});
