import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ToolExecutor } from "../../src/app/tools/tool-executor.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { createCommitGate } from "../helpers/commit-gate.js";
import { createFakeNoteStore } from "../helpers/fake-note-store.js";
import { connectRawMcp, type RawMcpPeer } from "../helpers/mcp-raw-peer.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";
import { recordNoteStore } from "../helpers/recording-note-store.js";

const KEY = "caller-chosen-key-0001";

const OTHER_KEY = "caller-chosen-key-0002";

const OWN_ROLLBACK_CLAIM = /rolled back|not saved|did not save|no note was|nothing was written/i;

const resultSchema = z.object({
  result: z.object({ structuredContent: z.object({ noteId: z.string(), created: z.boolean() }) }),
});

function createNoteParams(text: string, idempotencyKey: string) {
  return { name: "create_note", arguments: { text, idempotencyKey } };
}

/** A write whose commit window the test controls, behind a store that records what reaches it. */
function slowStore() {
  const gate = createCommitGate();
  const notes = createFakeNoteStore({ beforeCommit: gate.beforeCommit });
  const store = recordNoteStore(notes);

  return { gate, notes, store, tools: [defineCreateNoteTool(store)] };
}

async function retried(peer: RawMcpPeer, id: number, text: string, key: string) {
  await peer.request(id, "tools/call", createNoteParams(text, key));

  return resultSchema.parse(await peer.whenResponse(id)).result.structuredContent;
}

describe("cancelling a keyed write", () => {
  it("before execution: the executor sees an aborted signal and the store is never reached", async () => {
    const { store, tools } = slowStore();
    const logger = createRecordingLogger();
    const reached = Promise.withResolvers<AbortSignal>();
    const proceed = Promise.withResolvers<void>();

    const peer = await connectRawMcp(
      {
        tools,
        wrapExecutor:
          (inner: ToolExecutor): ToolExecutor =>
          async (call, signal) => {
            reached.resolve(signal);
            await proceed.promise;

            return inner(call, signal);
          },
      },
      logger,
    );

    await peer.request(1, "tools/call", createNoteParams("never written", KEY));

    const signal = await reached.promise;

    expect(signal.aborted).toBe(false);

    await peer.notify("notifications/cancelled", { requestId: 1 });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    proceed.resolve();
    await peer.settle();

    expect(peer.responsesTo(1)).toEqual([]);
    expect(store.drafts).toEqual([]);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: "tool.failed",
        fields: expect.objectContaining({ outcome: "cancelled", handlerInvoked: false }),
      }),
    );
    await peer.close();
  });

  it("while the write is in progress: the signal reaches the store, the write still commits, and a retry replays it", async () => {
    const { gate, notes, store, tools } = slowStore();
    const logger = createRecordingLogger();
    const peer = await connectRawMcp({ tools }, logger);

    await peer.request(2, "tools/call", createNoteParams("committed anyway", KEY));
    await gate.whenEntered(1);
    expect(store.signals[0]?.aborted).toBe(false);

    await peer.notify("notifications/cancelled", { requestId: 2 });
    await vi.waitFor(() => expect(store.signals[0]?.aborted).toBe(true));
    expect(notes.notes.size).toBe(0);

    gate.release(0);
    await vi.waitFor(() => expect(notes.notes.size).toBe(1));
    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: "tool.settled_late",
          fields: expect.objectContaining({ lateOutcome: "returned" }),
        }),
      ),
    );
    await peer.settle();

    expect(peer.responsesTo(2)).toEqual([]);

    gate.release(1);

    const replay = await retried(peer, 3, "committed anyway", KEY);

    expect(replay.created).toBe(false);
    expect(notes.notes.size).toBe(1);
    expect(JSON.stringify(peer.received)).not.toMatch(OWN_ROLLBACK_CLAIM);
    await peer.close();
  });

  it("after the write commits but before the response is sent: no response, and a retry replays", async () => {
    const notes = createFakeNoteStore();
    const committed = Promise.withResolvers<AbortSignal>();
    const proceed = Promise.withResolvers<void>();

    // No commit gate here: the write commits straight away and only the response is held back.
    const peer = await connectRawMcp({
      tools: [defineCreateNoteTool(notes)],
      wrapExecutor:
        (inner: ToolExecutor): ToolExecutor =>
        async (call, signal) => {
          const outcome = await inner(call, signal);

          committed.resolve(signal);
          await proceed.promise;

          return outcome;
        },
    });

    await peer.request(4, "tools/call", createNoteParams("already saved", KEY));

    const signal = await committed.promise;

    expect(notes.notes.size).toBe(1);

    await peer.notify("notifications/cancelled", { requestId: 4 });
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    proceed.resolve();
    await peer.settle();

    expect(peer.responsesTo(4)).toEqual([]);

    const replay = await retried(peer, 5, "already saved", KEY);

    expect(replay.created).toBe(false);
    expect(notes.notes.size).toBe(1);
    await peer.close();
  });

  it("during concurrent independent writes: only the cancelled call is silenced, both effects commit", async () => {
    const { gate, notes, store, tools } = slowStore();
    const peer = await connectRawMcp({ tools });

    await peer.request(10, "tools/call", createNoteParams("cancelled one", KEY));
    await peer.request(11, "tools/call", createNoteParams("surviving one", OTHER_KEY));
    await gate.whenEntered(2);

    await peer.notify("notifications/cancelled", { requestId: 10 });
    await vi.waitFor(() => expect(store.signals[0]?.aborted).toBe(true));
    expect(store.signals[1]?.aborted).toBe(false);

    gate.release(1);
    gate.release(0);
    gate.release(2);

    const survivor = resultSchema.parse(await peer.whenResponse(11)).result.structuredContent;

    await vi.waitFor(() => expect(notes.notes.size).toBe(2));
    await peer.settle();

    expect(survivor.created).toBe(true);
    expect(peer.responsesTo(10)).toEqual([]);

    const replay = await retried(peer, 12, "cancelled one", KEY);

    expect(replay.created).toBe(false);
    expect(notes.notes.size).toBe(2);
    await peer.close();
  });
});

describe("transport closure during a keyed write (EOF-equivalent)", () => {
  // Real process stdin EOF needs the stdio entrypoint, which is Slice 4: that exact test is
  // deferred to it. Closing the client side of the in-memory transport is what the SDK's stdio
  // transport does on EOF (it closes itself, and the protocol layer aborts in-flight requests).

  it("aborts the request, delivers nothing afterwards, and lets the write commit", async () => {
    const { gate, notes, store, tools } = slowStore();
    const logger = createRecordingLogger();
    const peer = await connectRawMcp({ tools }, logger);

    await peer.request(20, "tools/call", createNoteParams("written after close", KEY));
    await gate.whenEntered(1);
    expect(store.signals[0]?.aborted).toBe(false);

    await peer.disconnect();
    await vi.waitFor(() => expect(store.signals[0]?.aborted).toBe(true));

    const deliveredAtClose = peer.received.length;

    gate.release(0);
    await vi.waitFor(() => expect(notes.notes.size).toBe(1));
    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual(
        expect.objectContaining({ message: "tool.settled_late" }),
      ),
    );

    expect(peer.received).toHaveLength(deliveredAtClose);
    expect(peer.responsesTo(20)).toEqual([]);
  });

  it("makes a retry on a fresh connection to the same store safe", async () => {
    const { gate, notes, tools } = slowStore();
    const first = await connectRawMcp({ tools });

    await first.request(30, "tools/call", createNoteParams("survives a restart", KEY));
    await gate.whenEntered(1);
    await first.disconnect();
    gate.release(0);
    await vi.waitFor(() => expect(notes.notes.size).toBe(1));

    const second = await connectRawMcp({ tools });

    gate.release(1);

    const replay = await retried(second, 31, "survives a restart", KEY);

    expect(replay.created).toBe(false);
    expect(notes.notes.size).toBe(1);
    expect(JSON.stringify(second.received)).not.toMatch(OWN_ROLLBACK_CLAIM);
    await second.close();
  });
});
