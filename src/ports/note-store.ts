import type { Note } from "../domain/note.js";

/** A note to create. The key names the note: one key, at most one note. */
export interface NoteDraft {
  readonly idempotencyKey: string;
  readonly text: string;
  readonly createdAt: Date;
}

/**
 * `exists`: a note for this key was already committed; it is returned as stored so the caller can
 * tell a replay from a conflict. `unreadable` and `unavailable`: this call committed nothing.
 */
export type CreateNoteOutcome =
  | { readonly status: "created"; readonly note: Note }
  | { readonly status: "exists"; readonly note: Note }
  | { readonly status: "unreadable" }
  | { readonly status: "unavailable" };

export type ReadNoteOutcome =
  | { readonly status: "found"; readonly note: Note }
  | { readonly status: "not_found" }
  | { readonly status: "unreadable" }
  | { readonly status: "unavailable" };

/**
 * Durable note storage. `create` is atomic per key: concurrent calls with one key commit at most one
 * note. Both methods reject only when `signal` aborted before the commit point (for `create`) or
 * before the read finished; a rejection never carries a path or storage detail.
 */
export interface NoteStore {
  create(draft: NoteDraft, signal: AbortSignal): Promise<CreateNoteOutcome>;
  read(noteId: string, signal: AbortSignal): Promise<ReadNoteOutcome>;
}
