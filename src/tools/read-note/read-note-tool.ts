import { z } from "zod";
import { NOTE_ID_PATTERN, NOTE_TEXT_MAX_LENGTH } from "../../domain/note.js";
import { err, ok } from "../../domain/result.js";
import type { NoteStore } from "../../ports/note-store.js";
import { defineTool, type ToolDefinition } from "../tool-definition.js";

/** `read_note`: returns one note by the id `create_note` gave. */
export function defineReadNoteTool(notes: NoteStore): ToolDefinition {
  return defineTool({
    name: "read_note",
    description:
      "Returns the text of one saved note by its id, as returned by create_note. Use it when the " +
      "user asks what a note says. It cannot search or list notes.",
    risk: "read",
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: 2_000,
    inputSchema: z.strictObject({
      noteId: z
        .string()
        .length(32)
        .regex(NOTE_ID_PATTERN)
        .describe("The note id: 32 lowercase hexadecimal characters."),
    }),
    outputSchema: z.strictObject({
      noteId: z.string().regex(NOTE_ID_PATTERN).describe("The note id."),
      text: z.string().max(NOTE_TEXT_MAX_LENGTH).describe("The text of the note."),
      createdAt: z.iso.datetime().describe("When the note was saved, ISO 8601 in UTC."),
    }),
    failures: {
      note_not_found: "No note with this id exists.",
      note_unreadable: "The stored note cannot be read.",
      storage_unavailable: "The note store is unavailable. Try again later.",
    },
    execute: async ({ noteId }, context) => {
      const outcome = await notes.read(noteId, context.signal);

      switch (outcome.status) {
        case "found":
          return ok({
            noteId: outcome.note.id,
            text: outcome.note.text,
            createdAt: outcome.note.createdAt.toISOString(),
          });
        case "not_found":
          return err("note_not_found");
        case "unreadable":
          return err("note_unreadable");
        case "unavailable":
          return err("storage_unavailable");
      }
    },
  });
}
