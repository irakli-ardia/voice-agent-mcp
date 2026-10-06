import { z } from "zod";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  NOTE_ID_PATTERN,
  NOTE_TEXT_MAX_LENGTH,
  type Note,
} from "../../domain/note.js";
import { err, ok } from "../../domain/result.js";
import type { NoteStore } from "../../ports/note-store.js";
import { defineTool, type ToolDefinition } from "../tool-definition.js";

/** A type alias, not an interface, so it stays assignable to the tool output's JSON object type. */
type CreatedNote = {
  readonly noteId: string;
  readonly createdAt: string;
  readonly created: boolean;
};

function describeNote(note: Note, created: boolean): CreatedNote {
  return { noteId: note.id, createdAt: note.createdAt.toISOString(), created };
}

/**
 * `create_note`: a write keyed by a required idempotency key. The key names the note, so a retry
 * with the same key (after `timed_out`, `cancelled`, or any unknown outcome) never writes twice.
 */
export function defineCreateNoteTool(notes: NoteStore): ToolDefinition {
  return defineTool({
    name: "create_note",
    description:
      "Saves a short text note and returns its id. Use it only when the user explicitly asks to " +
      "save, note down, or remember something. Saved notes cannot be changed or deleted.",
    risk: "write",
    requiresConfirmation: false,
    timeoutMs: 5_000,
    inputSchema: z.strictObject({
      text: z.string().min(1).max(NOTE_TEXT_MAX_LENGTH).describe("The text of the note."),
      idempotencyKey: z
        .string()
        .min(IDEMPOTENCY_KEY_MIN_LENGTH)
        .max(IDEMPOTENCY_KEY_MAX_LENGTH)
        .regex(IDEMPOTENCY_KEY_PATTERN)
        .describe(
          "Identifies this one note request: 16 to 64 letters, digits, '-' or '_', such as a " +
            "UUID. Use a new key for every new note; reuse the same key only to retry a call " +
            "whose outcome is unknown, so the note is never saved twice.",
        ),
    }),
    outputSchema: z.strictObject({
      noteId: z.string().regex(NOTE_ID_PATTERN).describe("The id to read the note with."),
      createdAt: z.iso.datetime().describe("When the note was first saved, ISO 8601 in UTC."),
      created: z
        .boolean()
        .describe("False when an earlier call with the same key had already saved this note."),
    }),
    failures: {
      idempotency_key_conflict:
        "This idempotency key was already used for a note with different text. Use a new key " +
        "for a new note.",
      note_unreadable: "A note already exists for this request but cannot be read.",
      storage_unavailable:
        "The note store is unavailable; this call did not save the note. Retrying the same " +
        "request is safe.",
    },
    execute: async ({ text, idempotencyKey }, context) => {
      const outcome = await notes.create(
        { idempotencyKey, text, createdAt: context.clock.now() },
        context.signal,
      );

      switch (outcome.status) {
        case "created":
          return ok(describeNote(outcome.note, true));
        case "exists":
          return outcome.note.text === text
            ? ok(describeNote(outcome.note, false))
            : err("idempotency_key_conflict");
        case "unreadable":
          return err("note_unreadable");
        case "unavailable":
          return err("storage_unavailable");
      }
    },
  });
}
