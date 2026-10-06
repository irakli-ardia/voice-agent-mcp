import type { Note } from "../../src/domain/note.js";
import type {
  CreateNoteOutcome,
  NoteDraft,
  NoteStore,
  ReadNoteOutcome,
} from "../../src/ports/note-store.js";

export interface FakeNoteStore extends NoteStore {
  /** Committed notes by id. */
  readonly notes: ReadonlyMap<string, Note>;
  /** How many times `create` and `read` were called, so tests can prove a store was never reached. */
  readonly calls: { readonly create: number; readonly read: number };
}

export interface FakeNoteStoreOptions {
  /**
   * Runs between the entry abort check and the commit, once per `create` call (0-based). It models
   * the I/O window in which an abort no longer stops the write, as with the real store's link.
   */
  readonly beforeCommit?: (callIndex: number) => Promise<void>;
}

/**
 * In-memory `NoteStore` that keeps the port contract: one id per key, an atomic check-and-set
 * commit (synchronous, after the last await), and a rejection only for an abort before the commit.
 */
export function createFakeNoteStore(options: FakeNoteStoreOptions = {}): FakeNoteStore {
  const notes = new Map<string, Note>();
  const idsByKey = new Map<string, string>();
  const calls = { create: 0, read: 0 };

  const idFor = (key: string): string =>
    idsByKey.get(key) ?? (idsByKey.size + 1).toString(16).padStart(32, "0");

  return {
    notes,
    calls,
    create: async (draft: NoteDraft, signal: AbortSignal): Promise<CreateNoteOutcome> => {
      const callIndex = calls.create;

      calls.create += 1;
      signal.throwIfAborted();
      await options.beforeCommit?.(callIndex);

      const id = idFor(draft.idempotencyKey);
      const existing = notes.get(id);

      if (existing !== undefined) {
        return { status: "exists", note: existing };
      }

      const note: Note = { id, text: draft.text, createdAt: draft.createdAt };

      idsByKey.set(draft.idempotencyKey, id);
      notes.set(id, note);

      return { status: "created", note };
    },
    read: async (noteId: string, signal: AbortSignal): Promise<ReadNoteOutcome> => {
      calls.read += 1;
      signal.throwIfAborted();

      const note = notes.get(noteId);

      return note === undefined ? { status: "not_found" } : { status: "found", note };
    },
  };
}
