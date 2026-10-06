import { describe, expect, it } from "vitest";
import type { ReadNoteOutcome } from "../../../../src/ports/note-store.js";
import { defineReadNoteTool } from "../../../../src/tools/read-note/read-note-tool.js";
import { createFakeNoteStore } from "../../../helpers/fake-note-store.js";
import { runTool } from "../../../helpers/run-tool.js";

const SIGNAL = new AbortController().signal;

describe("read_note", () => {
  it("returns a saved note without its idempotency key", async () => {
    const store = createFakeNoteStore();

    const created = await store.create(
      {
        idempotencyKey: "note-key-0123456789",
        text: "Call the dentist",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
      },
      SIGNAL,
    );

    const noteId = created.status === "created" ? created.note.id : "";

    expect(await runTool(defineReadNoteTool(store), { arguments: { noteId } })).toEqual({
      ok: true,
      value: { noteId, text: "Call the dentist", createdAt: "2026-01-02T03:04:05.000Z" },
    });
  });

  it("reports an unknown id as not found", async () => {
    const result = await runTool(defineReadNoteTool(createFakeNoteStore()), {
      arguments: { noteId: "0".repeat(32) },
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "execution_failed", message: "No note with this id exists." },
    });
  });

  it.each([
    ["a path", "../../../../etc/passwd"],
    ["a file name", `${"0".repeat(32)}.json`],
    ["uppercase hex", "A".repeat(32)],
    ["31 characters", "0".repeat(31)],
    ["33 characters", "0".repeat(33)],
    ["an empty string", ""],
    ["a number", 42],
  ])("rejects %s before reaching the store", async (_label, noteId) => {
    const store = createFakeNoteStore();

    const result = await runTool(defineReadNoteTool(store), { arguments: { noteId } });

    expect(result.ok ? "ok" : result.error.code).toBe("invalid_input");
    expect(store.calls.read).toBe(0);
  });

  it.each([
    [{ status: "unreadable" }, "The stored note cannot be read."],
    [{ status: "unavailable" }, "The note store is unavailable. Try again later."],
  ] satisfies [ReadNoteOutcome, string][])(
    "maps %j to its declared, static message",
    async (outcome, message) => {
      const tool = defineReadNoteTool({
        create: async () => ({ status: "unavailable" }),
        read: async () => outcome,
      });

      expect(await runTool(tool, { arguments: { noteId: "0".repeat(32) } })).toEqual({
        ok: false,
        error: { code: "execution_failed", message },
      });
    },
  );
});
