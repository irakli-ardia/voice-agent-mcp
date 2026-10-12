import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFileNoteStore } from "../../src/adapters/persistence/file-note-store.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { defineReadNoteTool } from "../../src/tools/read-note/read-note-tool.js";
import { connectMcp } from "../helpers/mcp-harness.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-note-quota-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

function keyOf(label: number): string {
  return `mcp-quota-key-${String(label).padStart(6, "0")}`;
}

async function connect(maxNotes: number) {
  const store = createFileNoteStore({
    directory: join(root, "notes"),
    slotDirectory: join(root, "note-slots"),
    maxNotes,
    logger: createRecordingLogger(),
  });

  const connection = await connectMcp({
    tools: [defineCreateNoteTool(store), defineReadNoteTool(store)],
  });

  const create = async (label: number, text = "an MCP note") =>
    connection.client.callTool({
      name: "create_note",
      arguments: { text, idempotencyKey: keyOf(label) },
    });

  return { ...connection, create };
}

describe("MCP and the note quota", () => {
  it("refuses a new note over the quota as a static tool failure, and keeps the saved ones readable", async () => {
    const { create, client, close } = await connect(2);

    const first = await create(1);
    const second = await create(2);
    const refused = await create(3);

    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toBeUndefined();
    expect(textOf(refused)).toBe(
      "execution_failed: The note store is full; this call did not save the note. Existing notes " +
        "can still be read, and retrying a request that was already saved returns it.",
    );

    const noteId = z.object({ noteId: z.string() }).parse(first.structuredContent).noteId;
    const read = await client.callTool({ name: "read_note", arguments: { noteId } });

    expect(read.isError).toBeUndefined();
    await close();
  });

  it("answers a replay of a saved note at the quota as the original, never as a refusal", async () => {
    const { create, close } = await connect(1);

    await create(1);

    const replay = await create(1);

    expect(replay.isError).toBeUndefined();
    expect(replay.structuredContent).toEqual(expect.objectContaining({ created: false }));
    await close();
  });

  it("never exposes a path, a key, or the note text in the refusal", async () => {
    const { create, close } = await connect(1);

    await create(1, "first note");

    const refused = await create(2, "SECRET-NOTE-TEXT");

    expect(JSON.stringify(refused)).not.toContain(root);
    expect(JSON.stringify(refused)).not.toContain("SECRET-NOTE-TEXT");
    expect(JSON.stringify(refused)).not.toContain(keyOf(2));
    await close();
  });

  it("holds the quota under concurrent calls from one client", async () => {
    const { create, close } = await connect(3);

    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => create(index + 1)),
    );

    const created = results.filter((result) => result.isError === undefined);

    expect(created).toHaveLength(3);
    expect(results.filter((result) => result.isError === true)).toHaveLength(9);
    await close();
  });
});
