import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFileNoteStore } from "../../src/adapters/persistence/file-note-store.js";
import { ok } from "../../src/domain/result.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { defineReadNoteTool } from "../../src/tools/read-note/read-note-tool.js";
import { defineTool } from "../../src/tools/tool-definition.js";
import { createCommitGate } from "../helpers/commit-gate.js";
import { createFakeNoteStore } from "../helpers/fake-note-store.js";
import { connectMcp } from "../helpers/mcp-harness.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";
import { recordNoteStore } from "../helpers/recording-note-store.js";

const KEY = "caller-chosen-key-0001";

const OTHER_KEY = "caller-chosen-key-0002";

const createdSchema = z.object({ noteId: z.string(), created: z.boolean() });

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

function createNote(text: string, idempotencyKey: string) {
  return { name: "create_note", arguments: { text, idempotencyKey } };
}

describe("keyed writes through MCP", () => {
  it("writes once on the first call, with the caller's key reaching the store unchanged", async () => {
    const store = recordNoteStore(createFakeNoteStore());
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(store)] });
    const result = await client.callTool(createNote("first", KEY));

    expect(createdSchema.parse(result.structuredContent).created).toBe(true);
    expect(store.drafts.map((draft) => draft.idempotencyKey)).toEqual([KEY]);
    await close();
  });

  it("never rewrites, normalises, or generates a key: case and look-alikes stay distinct", async () => {
    const store = recordNoteStore(createFakeNoteStore());
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(store)] });
    const keys = ["KeyKeyKeyKeyKey01", "keykeykeykeykey01", "Key_Key-Key_Key-01"];

    for (const key of keys) {
      await client.callTool(createNote("same text", key));
    }

    expect(store.drafts.map((draft) => draft.idempotencyKey)).toEqual(keys);
    await close();
  });

  it("replays the original note for the same key and the same payload", async () => {
    const store = recordNoteStore(createFakeNoteStore());
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(store)] });

    const first = createdSchema.parse(
      (await client.callTool(createNote("same", KEY))).structuredContent,
    );

    const replay = createdSchema.parse(
      (await client.callTool(createNote("same", KEY))).structuredContent,
    );

    expect(first.created).toBe(true);
    expect(replay).toEqual({ noteId: first.noteId, created: false });
    await close();
  });

  it("fails the same key with a different payload and leaves the original note", async () => {
    const notes = createFakeNoteStore();
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(notes)] });

    await client.callTool(createNote("original", KEY));

    const conflict = await client.callTool(createNote("different", KEY));

    expect(conflict.isError).toBe(true);
    expect(textOf(conflict)).toMatch(/^execution_failed: This idempotency key was already used/);
    expect([...notes.notes.values()].map((note) => note.text)).toEqual(["original"]);
    await close();
  });

  it("creates distinct notes for distinct keys with identical payloads", async () => {
    const notes = createFakeNoteStore();
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(notes)] });

    const a = createdSchema.parse(
      (await client.callTool(createNote("twin", KEY))).structuredContent,
    );

    const b = createdSchema.parse(
      (await client.callTool(createNote("twin", OTHER_KEY))).structuredContent,
    );

    expect(a.noteId).not.toBe(b.noteId);
    expect(notes.notes.size).toBe(2);
    await close();
  });

  it("makes concurrent same-key writes one effect, even with both inside the commit window", async () => {
    const gate = createCommitGate();
    const notes = createFakeNoteStore({ beforeCommit: gate.beforeCommit });
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(notes)] });
    const first = client.callTool(createNote("raced", KEY));
    const second = client.callTool(createNote("raced", KEY));

    await gate.whenEntered(2);
    expect(notes.notes.size).toBe(0);

    gate.release(0);
    gate.release(1);

    const outcomes = [await first, await second].map((result) =>
      createdSchema.parse(result.structuredContent),
    );

    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.noteId)).size).toBe(1);
    expect(notes.notes.size).toBe(1);
    await close();
  });

  it("runs independent keyed writes at the same time", async () => {
    const gate = createCommitGate();
    const notes = createFakeNoteStore({ beforeCommit: gate.beforeCommit });
    const { client, close } = await connectMcp({ tools: [defineCreateNoteTool(notes)] });
    const first = client.callTool(createNote("one", KEY));
    const second = client.callTool(createNote("two", OTHER_KEY));

    await gate.whenEntered(2);
    expect(notes.notes.size).toBe(0);

    gate.release(1);
    gate.release(0);
    await Promise.all([first, second]);

    expect(notes.notes.size).toBe(2);
    await close();
  });
});

describe("persistent storage across application recreation", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function freshDirectory(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "mcp-notes-"));

    directories.push(dir);

    return dir;
  }

  function tools(directory: string) {
    const store = createFileNoteStore({ directory, logger: createRecordingLogger() });

    return [defineCreateNoteTool(store), defineReadNoteTool(store)];
  }

  it("replays the same key after the server and store are rebuilt on the same directory", async () => {
    const directory = await freshDirectory();
    const first = await connectMcp({ tools: tools(directory) });

    const created = createdSchema.parse(
      (await first.client.callTool(createNote("kept", KEY))).structuredContent,
    );

    await first.close();

    const second = await connectMcp({ tools: tools(directory) });

    const replay = createdSchema.parse(
      (await second.client.callTool(createNote("kept", KEY))).structuredContent,
    );

    const read = await second.client.callTool({
      name: "read_note",
      arguments: { noteId: created.noteId },
    });

    expect(created.created).toBe(true);
    expect(replay).toEqual({ noteId: created.noteId, created: false });
    expect(read.structuredContent).toMatchObject({ noteId: created.noteId, text: "kept" });

    const conflict = await second.client.callTool(createNote("changed", KEY));

    expect(conflict.isError).toBe(true);
    await second.close();
  });

  it("keeps same-key concurrent calls to one note on the real store", async () => {
    const directory = await freshDirectory();
    const { client, close } = await connectMcp({ tools: tools(directory) });

    const outcomes = (
      await Promise.all(
        Array.from({ length: 6 }, async () => client.callTool(createNote("raced", KEY))),
      )
    ).map((result) => createdSchema.parse(result.structuredContent));

    expect(outcomes.filter((outcome) => outcome.created)).toHaveLength(1);
    expect(new Set(outcomes.map((outcome) => outcome.noteId)).size).toBe(1);
    await close();
  });
});

describe("retry after an unknown outcome", () => {
  it("is safe: a timed-out write may still commit, and the same key then replays it", async () => {
    const effects = new Map<string, number>();
    const gate = Promise.withResolvers<void>();

    const slowWrite = defineTool({
      name: "slow_write",
      description: "A keyed write that is slower than its deadline and ignores cancellation.",
      risk: "write",
      requiresConfirmation: false,
      idempotency: "key",
      timeoutMs: 30,
      inputSchema: z.strictObject({
        idempotencyKey: z
          .string()
          .min(16)
          .max(64)
          .regex(/^[A-Za-z0-9_-]+$/),
      }),
      outputSchema: z.strictObject({ created: z.boolean() }),
      failures: {},
      execute: async ({ idempotencyKey }) => {
        await gate.promise;

        const known = effects.has(idempotencyKey);

        effects.set(idempotencyKey, (effects.get(idempotencyKey) ?? 0) + (known ? 0 : 1));

        return ok({ created: !known });
      },
    });

    const { client, close } = await connectMcp({ tools: [slowWrite] });

    const timedOut = await client.callTool({
      name: "slow_write",
      arguments: { idempotencyKey: KEY },
    });

    expect(timedOut.isError).toBe(true);
    expect(textOf(timedOut)).toBe(
      "timed_out: The tool did not finish within its time limit; its outcome is unknown.",
    );
    expect(textOf(timedOut)).not.toMatch(/rolled back|not saved|no effect|nothing was/i);
    expect(effects.size).toBe(0);

    gate.resolve();
    await vi.waitFor(() => expect(effects.size).toBe(1));

    const retried = await client.callTool({
      name: "slow_write",
      arguments: { idempotencyKey: KEY },
    });

    expect(retried.structuredContent).toEqual({ created: false });
    expect(effects.get(KEY)).toBe(1);
    await close();
  });
});
