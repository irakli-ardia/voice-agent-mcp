import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { NOTE_ID_PATTERN, type Note } from "../../domain/note.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { Logger } from "../../ports/logger.js";
import type {
  CreateNoteOutcome,
  NoteDraft,
  NoteStore,
  ReadNoteOutcome,
} from "../../ports/note-store.js";
import { errorCodeOf, type FileIdentity, type NoteFiles, nodeNoteFiles } from "./note-files.js";
import { decodeRecord, MAX_RECORD_BYTES, type NoteRecord, noteIdFor } from "./note-record.js";
import { type ClaimOutcome, createNoteSlots, type NoteSlots } from "./note-slots.js";

export { type NoteFiles, nodeNoteFiles };

/** The quota when a caller does not choose one; the configuration default matches. */
const DEFAULT_MAX_NOTES = 10_000;

export interface FileNoteStoreOptions {
  /** Absolute directory holding only note files and their temp files; created on first write. */
  readonly directory: string;
  readonly logger: Logger;
  /** Directory of the quota slots, on the same filesystem; default: `<directory>.slots`. */
  readonly slotDirectory?: string;
  /** The most notes the store holds (default `DEFAULT_MAX_NOTES`). */
  readonly maxNotes?: number;
  /** Replaced only in tests. */
  readonly files?: NoteFiles;
  /** Milliseconds since the epoch; replaced only in tests. */
  readonly now?: () => number;
}

interface StoreDependencies {
  readonly directory: string;
  readonly logger: Logger;
  readonly files: NoteFiles;
  readonly slots: NoteSlots;
  readonly maxNotes: number;
  readonly directories: readonly string[];
  /** Set once the directories and the slots are ready; shared by every call of this process. */
  ready: Promise<void> | undefined;
}

type RecordProblem =
  | "too_large"
  | "invalid_json"
  | "invalid_record"
  | "id_mismatch"
  | "key_mismatch";

type RecordOutcome =
  | { readonly status: "found"; readonly record: NoteRecord }
  | { readonly status: "not_found" }
  | { readonly status: "unreadable" }
  | { readonly status: "unavailable" };

type Operation = "create" | "read";

type Phase = "mkdir" | "init" | "write" | "link" | "read";

type Unavailable = Extract<ReadNoteOutcome, { readonly status: "unavailable" }>;

type Unreadable = Extract<ReadNoteOutcome, { readonly status: "unreadable" }>;

function notePath(directory: string, noteId: string): string {
  return join(directory, `${noteId}.json`);
}

/** Our own abort error: the signal's reason is caller-supplied and must not travel further. */
function abortError(): DOMException {
  return new DOMException("The note store operation was aborted.", "AbortError");
}

function toNote(record: NoteRecord): Note {
  return { id: record.noteId, text: record.text, createdAt: new Date(record.createdAt) };
}

function parseRecord(bytes: Uint8Array, noteId: string): Result<NoteRecord, RecordProblem> {
  const decoded = decodeRecord(bytes);

  if (!decoded.ok) {
    return decoded;
  }

  return decoded.value.noteId === noteId ? ok(decoded.value) : err("id_mismatch");
}

function unavailable(
  dependencies: StoreDependencies,
  operation: Operation,
  phase: Phase,
  code: string,
): Unavailable {
  dependencies.logger.warn("note_store.unavailable", { operation, phase, errorCode: code });

  return { status: "unavailable" };
}

/** Logged at error level: a committed record that fails validation needs an operator. */
function unreadable(
  dependencies: StoreDependencies,
  operation: Operation,
  noteId: string,
  problem: RecordProblem,
): Unreadable {
  dependencies.logger.error("note_store.unreadable", { operation, noteId, problem });

  return { status: "unreadable" };
}

async function readRecord(
  dependencies: StoreDependencies,
  operation: Operation,
  noteId: string,
  signal: AbortSignal,
): Promise<RecordOutcome> {
  let read: Result<Uint8Array, "too_large">;

  try {
    read = await dependencies.files.readAtMost(
      notePath(dependencies.directory, noteId),
      MAX_RECORD_BYTES,
      signal,
    );
  } catch (cause) {
    if (signal.aborted) {
      throw abortError();
    }

    const code = errorCodeOf(cause);

    return code === "ENOENT"
      ? { status: "not_found" }
      : unavailable(dependencies, operation, "read", code);
  }

  const record = read.ok ? parseRecord(read.value, noteId) : read;

  return record.ok
    ? { status: "found", record: record.value }
    : unreadable(dependencies, operation, noteId, record.error);
}

/** Which preparation step failed, and the system error code it failed with. */
class PreparationError extends Error {
  readonly phase: "mkdir" | "init";
  readonly code: string;

  constructor(phase: "mkdir" | "init", code: string) {
    super(phase);
    this.phase = phase;
    this.code = code;
  }
}

/**
 * Prepares the store once per process: both directories, then the slots. Concurrent calls share one
 * attempt; a failed attempt is forgotten so the next call tries again.
 */
async function prepare(dependencies: StoreDependencies): Promise<Unavailable | undefined> {
  dependencies.ready ??= (async (): Promise<void> => {
    for (const path of dependencies.directories) {
      await dependencies.files.makeDirectory(path).catch((cause: unknown) => {
        throw new PreparationError("mkdir", errorCodeOf(cause));
      });
    }

    await dependencies.slots.initialize().catch((cause: unknown) => {
      throw new PreparationError("init", errorCodeOf(cause));
    });
  })();

  try {
    await dependencies.ready;

    return undefined;
  } catch (cause) {
    dependencies.ready = undefined;

    return cause instanceof PreparationError
      ? unavailable(dependencies, "create", cause.phase, cause.code)
      : unavailable(dependencies, "create", "init", errorCodeOf(cause));
  }
}

/** Classifies the record that holds the key. This call committed nothing. */
async function existingNote(
  dependencies: StoreDependencies,
  draft: NoteDraft,
  noteId: string,
  signal: AbortSignal,
): Promise<CreateNoteOutcome> {
  const outcome = await readRecord(dependencies, "create", noteId, signal);

  switch (outcome.status) {
    case "found":
      // A different key here means a truncated-hash collision: never hand back its note.
      return outcome.record.idempotencyKey === draft.idempotencyKey
        ? { status: "exists", note: toNote(outcome.record) }
        : unreadable(dependencies, "create", noteId, "key_mismatch");
    case "not_found":
      return unavailable(dependencies, "create", "read", "ENOENT");
    case "unreadable":
    case "unavailable":
      return outcome;
  }
}

async function removeTempFile(dependencies: StoreDependencies, tempPath: string): Promise<void> {
  try {
    await dependencies.files.remove(tempPath);
  } catch (cause) {
    const code = errorCodeOf(cause);

    // ENOENT: opening the temp file failed, or a sweep already removed it; nothing to remove.
    if (code !== "ENOENT") {
      dependencies.logger.warn("note_store.temp_cleanup_failed", { errorCode: code });
    }
  }
}

/**
 * Runs one step before the commit point. An abort stays an abort; any other failure is logged and
 * reported as `false`: nothing was committed by this call.
 */
async function preCommitStep(
  dependencies: StoreDependencies,
  phase: "write",
  signal: AbortSignal,
  step: () => Promise<void>,
): Promise<boolean> {
  try {
    await step();

    return true;
  } catch (cause) {
    if (signal.aborted) {
      throw abortError();
    }

    unavailable(dependencies, "create", phase, errorCodeOf(cause));

    return false;
  }
}

async function identityOrUndefined(
  dependencies: StoreDependencies,
  path: string,
): Promise<FileIdentity | undefined> {
  try {
    return await dependencies.files.identityOf(path);
  } catch {
    return undefined;
  }
}

/** Whether the note's name is taken, by anything: a replay never needs a slot. */
async function noteExists(dependencies: StoreDependencies, noteId: string): Promise<boolean> {
  return (
    (await identityOrUndefined(dependencies, notePath(dependencies.directory, noteId))) !==
    undefined
  );
}

/**
 * Past the slot claim: this call holds a quota slot and a durable record, so publishing the note is
 * its to finish, and an abort no longer stops it. The slot is released only when the note belongs to
 * someone else, or when it could not be published at all and nobody published it for us.
 */
async function publish(
  dependencies: StoreDependencies,
  draft: NoteDraft,
  noteId: string,
  tempPath: string,
  claim: Extract<ClaimOutcome, { readonly status: "claimed" }>,
  record: NoteRecord,
  signal: AbortSignal,
): Promise<CreateNoteOutcome> {
  const { files, directory } = dependencies;
  const target = notePath(directory, noteId);

  try {
    await files.link(tempPath, target);

    return { status: "created", note: toNote(record) };
  } catch (cause) {
    const code = errorCodeOf(cause);

    // Someone published this very file first: recovery, from the slot this call claimed.
    if (await claim.holds(target)) {
      return { status: "created", note: toNote(record) };
    }

    // A note exists and is not ours, so our record can never be published and its slot is surplus.
    // Any other failure leaves the record where it is: the note may yet be published from it, by
    // recovery, and nothing that might be published is ever released.
    if (code === "EEXIST") {
      await claim.release();

      return existingNote(dependencies, draft, noteId, signal);
    }

    return unavailable(dependencies, "create", "link", code);
  }
}

/**
 * Writes a complete, fsynced temp file, claims a slot for it (the quota reservation, holding a
 * second name of the same file), then publishes it under the note's name. Publication, the
 * exclusive `link`, is when the note comes into existence, and what replays and conflicting replays
 * agree on. Before the claim nothing is visible and an abort stops the call; after it the call
 * finishes the publication whatever the signal says.
 */
async function writeNote(
  dependencies: StoreDependencies,
  draft: NoteDraft,
  tempPath: string,
  signal: AbortSignal,
): Promise<CreateNoteOutcome> {
  const noteId = noteIdFor(draft.idempotencyKey);

  const record: NoteRecord = {
    noteId,
    idempotencyKey: draft.idempotencyKey,
    text: draft.text,
    createdAt: draft.createdAt.toISOString(),
  };

  const written = await preCommitStep(dependencies, "write", signal, () =>
    dependencies.files.writeSynced(tempPath, JSON.stringify(record), signal),
  );

  if (!written) {
    return { status: "unavailable" };
  }

  // An abort here is stopped by the claim, which checks the signal before taking any slot.
  let claim: ClaimOutcome;

  try {
    claim = await dependencies.slots.claim(tempPath, signal);
  } catch (cause) {
    if (signal.aborted) {
      throw abortError();
    }

    return unavailable(dependencies, "create", "link", errorCodeOf(cause));
  }

  if (claim.status === "full") {
    // A create of the same key may have been published while this one looked for a slot.
    if (await noteExists(dependencies, noteId)) {
      return existingNote(dependencies, draft, noteId, signal);
    }

    dependencies.logger.warn("note_store.quota_exceeded", { limit: dependencies.maxNotes });

    return { status: "quota_exceeded" };
  }

  return publish(dependencies, draft, noteId, tempPath, claim, record, signal);
}

/**
 * One immutable JSON file per note, `<directory>/<noteId>.json`, published with an atomic,
 * exclusive hard link from a quota slot. Correct across concurrent calls and processes without any
 * lock, and never holding more than `maxNotes` notes. Survives a process crash at any point; not
 * guaranteed across an OS crash or power loss, because directories are never fsynced.
 */
export function createFileNoteStore(options: FileNoteStoreOptions): NoteStore {
  const files = options.files ?? nodeNoteFiles;
  const maxNotes = options.maxNotes ?? DEFAULT_MAX_NOTES;
  const slotDirectory = options.slotDirectory ?? `${options.directory}.slots`;

  const dependencies: StoreDependencies = {
    directory: options.directory,
    logger: options.logger,
    files,
    maxNotes,
    directories: [options.directory, slotDirectory],
    slots: createNoteSlots({
      files,
      notesDirectory: options.directory,
      slotDirectory,
      maxNotes,
      logger: options.logger,
      now: options.now ?? Date.now,
    }),
    ready: undefined,
  };

  return {
    create: async (draft: NoteDraft, signal: AbortSignal): Promise<CreateNoteOutcome> => {
      if (signal.aborted) {
        throw abortError();
      }

      const failed = await prepare(dependencies);

      if (failed !== undefined) {
        return failed;
      }

      if (signal.aborted) {
        throw abortError();
      }

      const noteId = noteIdFor(draft.idempotencyKey);

      // A key already used is a replay or a conflict: no temp file, no slot, whatever the quota.
      if (await noteExists(dependencies, noteId)) {
        return existingNote(dependencies, draft, noteId, signal);
      }

      const tempPath = join(dependencies.directory, `.tmp-${randomUUID()}`);

      try {
        return await writeNote(dependencies, draft, tempPath, signal);
      } finally {
        await removeTempFile(dependencies, tempPath);
      }
    },
    read: async (noteId: string, signal: AbortSignal): Promise<ReadNoteOutcome> => {
      if (signal.aborted) {
        throw abortError();
      }

      // Only hex digits pass, so no id can name a path outside the directory.
      if (!NOTE_ID_PATTERN.test(noteId)) {
        return { status: "not_found" };
      }

      const outcome = await readRecord(dependencies, "read", noteId, signal);

      if (outcome.status !== "found") {
        return outcome;
      }

      return noteIdFor(outcome.record.idempotencyKey) === noteId
        ? { status: "found", note: toNote(outcome.record) }
        : unreadable(dependencies, "read", noteId, "key_mismatch");
    },
  };
}
