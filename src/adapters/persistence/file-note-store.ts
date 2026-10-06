import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  NOTE_ID_PATTERN,
  NOTE_TEXT_MAX_LENGTH,
  type Note,
} from "../../domain/note.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { Logger } from "../../ports/logger.js";
import type {
  CreateNoteOutcome,
  NoteDraft,
  NoteStore,
  ReadNoteOutcome,
} from "../../ports/note-store.js";

/** A valid record is under 13 KB; anything larger is not one and is never read into memory. */
const MAX_RECORD_BYTES = 65_536;

/** The filesystem steps the store takes. Tests replace one to reach a branch a real disk cannot. */
export interface NoteFiles {
  makeDirectory(path: string): Promise<void>;
  /** Creates `path` exclusively, writes `data`, and fsyncs it before returning. */
  writeSynced(path: string, data: string, signal: AbortSignal): Promise<void>;
  /** Fails with `EEXIST` when `newPath` exists. A failed link creates nothing. */
  link(existingPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  /** The file's bytes, or `too_large` (unread) when it is bigger than `maxBytes`. */
  readAtMost(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, "too_large">>;
}

export const nodeNoteFiles: NoteFiles = {
  makeDirectory: async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  writeSynced: async (path: string, data: string, signal: AbortSignal): Promise<void> => {
    const handle = await open(path, "wx", 0o600);

    try {
      await handle.writeFile(data, { signal });
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  link: async (existingPath: string, newPath: string): Promise<void> => link(existingPath, newPath),
  remove: async (path: string): Promise<void> => unlink(path),
  readAtMost: async (
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, "too_large">> => {
    const handle = await open(path, "r");

    try {
      if ((await handle.stat()).size > maxBytes) {
        return err("too_large");
      }

      // ponytail: a file that grows after stat is read whole; only a local process can do that,
      // and the content is still schema-validated. Bounded reads if DATA_DIR stops being trusted.
      return ok(await handle.readFile({ signal }));
    } finally {
      await handle.close();
    }
  },
};

export interface FileNoteStoreOptions {
  /** Absolute directory holding only note files and their temp files; created on first write. */
  readonly directory: string;
  readonly logger: Logger;
  /** Replaced only in tests. */
  readonly files?: NoteFiles;
}

interface StoreDependencies {
  readonly directory: string;
  readonly logger: Logger;
  readonly files: NoteFiles;
}

const recordSchema = z.strictObject({
  noteId: z.string().regex(NOTE_ID_PATTERN),
  idempotencyKey: z
    .string()
    .min(IDEMPOTENCY_KEY_MIN_LENGTH)
    .max(IDEMPOTENCY_KEY_MAX_LENGTH)
    .regex(IDEMPOTENCY_KEY_PATTERN),
  text: z.string().min(1).max(NOTE_TEXT_MAX_LENGTH),
  createdAt: z.iso.datetime(),
});

type NoteRecord = z.output<typeof recordSchema>;

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

type Unavailable = Extract<ReadNoteOutcome, { readonly status: "unavailable" }>;

type Unreadable = Extract<ReadNoteOutcome, { readonly status: "unreadable" }>;

/** Only a short system error code (`ENOENT`) is ever kept: messages carry absolute paths. */
const errnoSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,32}$/) });

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Lowercase hex of the first 16 bytes of SHA-256 over the key's UTF-8 bytes (the key is ASCII). */
function noteIdFor(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32);
}

function notePath(directory: string, noteId: string): string {
  return join(directory, `${noteId}.json`);
}

function errorCode(cause: unknown): string {
  const parsed = errnoSchema.safeParse(cause);

  return parsed.success ? parsed.data.code : "unknown";
}

/** Our own abort error: the signal's reason is caller-supplied and must not travel further. */
function abortError(): DOMException {
  return new DOMException("The note store operation was aborted.", "AbortError");
}

function toNote(record: NoteRecord): Note {
  return { id: record.noteId, text: record.text, createdAt: new Date(record.createdAt) };
}

function parseRecord(bytes: Uint8Array, noteId: string): Result<NoteRecord, RecordProblem> {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(utf8.decode(bytes)));

    if (!parsed.success) {
      return err("invalid_record");
    }

    return parsed.data.noteId === noteId ? ok(parsed.data) : err("id_mismatch");
  } catch {
    return err("invalid_json");
  }
}

function unavailable(
  dependencies: StoreDependencies,
  operation: Operation,
  phase: "mkdir" | "write" | "link" | "read",
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

    const code = errorCode(cause);

    return code === "ENOENT"
      ? { status: "not_found" }
      : unavailable(dependencies, operation, "read", code);
  }

  const record = read.ok ? parseRecord(read.value, noteId) : read;

  return record.ok
    ? { status: "found", record: record.value }
    : unreadable(dependencies, operation, noteId, record.error);
}

/**
 * Runs one step before the commit point. An abort stays an abort; any other failure is logged and
 * reported as `false`: the link was never attempted, so this call committed nothing.
 */
async function preCommitStep(
  dependencies: StoreDependencies,
  phase: "mkdir" | "write",
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

    unavailable(dependencies, "create", phase, errorCode(cause));

    return false;
  }
}

/** Classifies the record that won the key. This call's link failed, so it committed nothing. */
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
    const code = errorCode(cause);

    // ENOENT: opening the temp file failed, so there is nothing to remove.
    if (code !== "ENOENT") {
      dependencies.logger.warn("note_store.temp_cleanup_failed", { errorCode: code });
    }
  }
}

/**
 * Writes a complete, fsynced temp file, then links it to the note's name. The successful link is
 * the only commit point: before it nothing is visible, after it the signal is ignored.
 */
async function publish(
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

  const { directory, files } = dependencies;

  const written = await preCommitStep(dependencies, "write", signal, () =>
    files.writeSynced(tempPath, JSON.stringify(record), signal),
  );

  if (!written) {
    return { status: "unavailable" };
  }

  if (signal.aborted) {
    throw abortError();
  }

  try {
    await files.link(tempPath, notePath(directory, noteId));
  } catch (cause) {
    const code = errorCode(cause);

    if (code === "EEXIST") {
      return existingNote(dependencies, draft, noteId, signal);
    }

    if (signal.aborted) {
      throw abortError();
    }

    return unavailable(dependencies, "create", "link", code);
  }

  return { status: "created", note: toNote(record) };
}

/**
 * One immutable JSON file per note, `<directory>/<noteId>.json`, published with an atomic,
 * exclusive hard link. Correct across concurrent calls and processes without any lock. Survives a
 * process crash once the link succeeded; not guaranteed across an OS crash or power loss, because
 * the directory is never fsynced.
 */
export function createFileNoteStore(options: FileNoteStoreOptions): NoteStore {
  const dependencies: StoreDependencies = {
    directory: options.directory,
    logger: options.logger,
    files: options.files ?? nodeNoteFiles,
  };

  return {
    create: async (draft: NoteDraft, signal: AbortSignal): Promise<CreateNoteOutcome> => {
      if (signal.aborted) {
        throw abortError();
      }

      const { directory, files } = dependencies;

      if (
        !(await preCommitStep(dependencies, "mkdir", signal, () => files.makeDirectory(directory)))
      ) {
        return { status: "unavailable" };
      }

      const tempPath = join(directory, `.tmp-${randomUUID()}`);

      try {
        return await publish(dependencies, draft, tempPath, signal);
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
