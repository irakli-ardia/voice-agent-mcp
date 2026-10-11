import type {
  CreateNoteOutcome,
  NoteDraft,
  NoteStore,
  ReadNoteOutcome,
} from "../../src/ports/note-store.js";

export interface RecordingNoteStore extends NoteStore {
  /** Every draft `create` was given, exactly as received. */
  readonly drafts: readonly NoteDraft[];
  /** The signal each `create` call received. */
  readonly signals: readonly AbortSignal[];
}

/** Wraps a store and records what reaches it, without changing what it does. */
export function recordNoteStore(inner: NoteStore): RecordingNoteStore {
  const drafts: NoteDraft[] = [];
  const signals: AbortSignal[] = [];

  return {
    drafts,
    signals,
    create: async (draft: NoteDraft, signal: AbortSignal): Promise<CreateNoteOutcome> => {
      drafts.push(draft);
      signals.push(signal);

      return inner.create(draft, signal);
    },
    read: async (noteId: string, signal: AbortSignal): Promise<ReadNoteOutcome> =>
      inner.read(noteId, signal),
  };
}
