import { constants } from "node:fs";
import { type FileHandle, lstat, open, unlink } from "node:fs/promises";
import { z } from "zod";
import { err, ok, type Result } from "../../domain/result.js";
import type {
  AudioFiles,
  AudioReadFailure,
  AudioReserveFailure,
  ReservedAudioFile,
} from "../../ports/audio-files.js";
import type { Logger } from "../../ports/logger.js";

/** A filesystem object's identity: the same object whatever path reaches it, and only that one. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** What an open file or a directory entry is: kind, size, and identity. */
export interface FileFacts {
  readonly regular: boolean;
  readonly size: bigint;
  readonly identity: FileIdentity;
}

/** The operations used on one open file. Tests wrap the real one to fail a step on demand. */
export interface OpenAudioFile {
  /** Facts about the open file itself, never about whatever its path names now. */
  stat(): Promise<FileFacts>;
  /** Reads up to `length` bytes at the current position into `buffer`; 0 at end of file. */
  read(buffer: Uint8Array, length: number): Promise<number>;
  /** Writes all of `bytes` from the start of the file, completing partial writes. */
  writeAll(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The filesystem steps the adapter takes. Tests replace one only for a branch a disk cannot produce. */
export interface AudioFileSystem {
  openForReading(path: string): Promise<OpenAudioFile>;
  /** Creates `path` exclusively; fails with `EEXIST` rather than replacing anything. */
  createExclusive(path: string): Promise<OpenAudioFile>;
  /** The entry at `path` itself, a final symlink not followed; `null` when there is none. */
  entryAt(path: string): Promise<FileFacts | null>;
  remove(path: string): Promise<void>;
}

/**
 * Read-only, and non-blocking where the platform defines it (POSIX), so opening a FIFO returns at
 * once and is then rejected as not a regular file. Windows has no `O_NONBLOCK` (it is undefined
 * there despite its declared type) and no FIFOs to block on.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** Owner read and write only, on POSIX; Windows applies the parent directory's ACLs. */
const OUTPUT_MODE = 0o600;

/** Bytes read per call, so memory follows the bytes actually read, never a reported size. */
const READ_CHUNK_BYTES = 65_536;

function wrapHandle(handle: FileHandle): OpenAudioFile {
  return {
    stat: async (): Promise<FileFacts> => {
      const stats = await handle.stat({ bigint: true });

      return {
        regular: stats.isFile(),
        size: stats.size,
        identity: { dev: stats.dev, ino: stats.ino },
      };
    },
    read: async (buffer: Uint8Array, length: number): Promise<number> =>
      (await handle.read(buffer, 0, length, null)).bytesRead,
    writeAll: async (bytes: Uint8Array, signal: AbortSignal): Promise<void> => {
      await handle.writeFile(bytes, { signal });
    },
    sync: async (): Promise<void> => handle.sync(),
    close: async (): Promise<void> => handle.close(),
  };
}

export const nodeAudioFileSystem: AudioFileSystem = {
  openForReading: async (path: string): Promise<OpenAudioFile> =>
    wrapHandle(await open(path, READ_FLAGS)),
  createExclusive: async (path: string): Promise<OpenAudioFile> =>
    wrapHandle(await open(path, "wx", OUTPUT_MODE)),
  entryAt: async (path: string): Promise<FileFacts | null> => {
    try {
      const stats = await lstat(path, { bigint: true });

      return {
        regular: stats.isFile(),
        size: stats.size,
        identity: { dev: stats.dev, ino: stats.ino },
      };
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") {
        return null;
      }

      throw cause;
    }
  },
  remove: async (path: string): Promise<void> => unlink(path),
};

export interface LocalAudioFilesOptions {
  readonly logger: Logger;
  /** Replaced only in tests. */
  readonly fileSystem?: AudioFileSystem;
}

interface Dependencies {
  readonly logger: Logger;
  readonly fs: AudioFileSystem;
}

type Operation = "read" | "reserve" | "write" | "discard";

/** Only a short system error code (`ENOENT`) is ever kept: messages carry absolute paths. */
const errnoSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,32}$/) });

function errorCode(cause: unknown): string {
  const parsed = errnoSchema.safeParse(cause);

  return parsed.success ? parsed.data.code : "unknown";
}

/** Our own abort error: the signal's reason is caller-supplied and must not travel further. */
function abortError(): DOMException {
  return new DOMException("The audio file operation was aborted.", "AbortError");
}

function logFailure(
  dependencies: Dependencies,
  operation: Operation,
  problem: string,
  cause?: unknown,
): void {
  dependencies.logger.warn(
    "audio_file.failed",
    cause === undefined
      ? { operation, problem }
      : { operation, problem, errorCode: errorCode(cause) },
  );
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Closes a file whose outcome is already decided; a close failure is logged, never thrown. */
async function closeQuietly(
  dependencies: Dependencies,
  operation: Operation,
  file: OpenAudioFile,
): Promise<void> {
  try {
    await file.close();
  } catch (cause) {
    logFailure(dependencies, operation, "close_failed", cause);
  }
}

/** Reads until end of file, but never more than `maxBytes + 1` bytes. */
async function readBounded(
  file: OpenAudioFile,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Result<Uint8Array, "too_large">> {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    if (signal.aborted) {
      throw abortError();
    }

    const chunk = new Uint8Array(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
    const bytesRead = await file.read(chunk, chunk.byteLength);

    if (bytesRead === 0) {
      break;
    }

    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;

    if (total > maxBytes) {
      return err("too_large");
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return ok(bytes);
}

/** Decides from the open handle, not the path: a regular file within the limit, read bounded. */
async function readOpenFile(
  dependencies: Dependencies,
  file: OpenAudioFile,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Result<Uint8Array, AudioReadFailure>> {
  try {
    const facts = await file.stat();

    if (!facts.regular) {
      logFailure(dependencies, "read", "not_regular_file");

      return err("unreadable");
    }

    // The reported size may be stale or zero (`/proc`); the bounded read is the real limit.
    if (facts.size > BigInt(maxBytes)) {
      return err("too_large");
    }

    return await readBounded(file, maxBytes, signal);
  } catch (cause) {
    if (signal.aborted) {
      throw abortError();
    }

    logFailure(dependencies, "read", "read_failed", cause);

    return err("unreadable");
  }
}

async function readAudio(
  dependencies: Dependencies,
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Result<Uint8Array, AudioReadFailure>> {
  if (signal.aborted) {
    throw abortError();
  }

  let file: OpenAudioFile;

  try {
    file = await dependencies.fs.openForReading(path);
  } catch (cause) {
    if (signal.aborted) {
      throw abortError();
    }

    logFailure(dependencies, "read", "open_failed", cause);

    return err("unreadable");
  }

  try {
    return await readOpenFile(dependencies, file, maxBytes, signal);
  } finally {
    await closeQuietly(dependencies, "read", file);
  }
}

/**
 * Removes the entry at `path` only when it is still the regular file this reservation created:
 * never an object that merely has the same name now. Never throws. Residual: an object swapped in
 * between the identity check and the unlink would be removed; that needs a local process with
 * write access to the output directory, and no portable Node API closes the gap.
 */
async function removeIfOwned(
  dependencies: Dependencies,
  path: string,
  owned: FileIdentity,
): Promise<void> {
  let entry: FileFacts | null;

  try {
    entry = await dependencies.fs.entryAt(path);
  } catch (cause) {
    logFailure(dependencies, "discard", "inspect_failed", cause);

    return;
  }

  if (entry === null) {
    return;
  }

  // Same device and inode: the very object this reservation created (a symlink has its own).
  if (!sameIdentity(entry.identity, owned)) {
    logFailure(dependencies, "discard", "not_owned");

    return;
  }

  try {
    await dependencies.fs.remove(path);
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") {
      logFailure(dependencies, "discard", "remove_failed", cause);
    }
  }
}

type ReservationState = "open" | "writing" | "committed" | "failed" | "discarded";

interface Reservation {
  readonly dependencies: Dependencies;
  readonly path: string;
  readonly file: OpenAudioFile;
  readonly identity: FileIdentity;
  state: ReservationState;
  /** Settles (never rejects) when the write in progress, if any, has finished. */
  writing: Promise<void>;
  discarding: Promise<void> | null;
}

/** Writes, syncs, and closes; the successful close is the commit point. */
async function commit(
  reservation: Reservation,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Result<void, "failed">> {
  const { dependencies, file } = reservation;

  try {
    await file.writeAll(bytes, signal);
    await file.sync();
  } catch (cause) {
    reservation.state = "failed";
    await closeQuietly(dependencies, "write", file);

    if (signal.aborted) {
      throw abortError();
    }

    logFailure(dependencies, "write", "write_failed", cause);

    return err("failed");
  }

  // The data is synced: the commit finishes even if the signal aborts now.
  try {
    await file.close();
  } catch (cause) {
    // A failed close may mean the data did not reach the disk: never reported as committed.
    reservation.state = "failed";
    logFailure(dependencies, "write", "close_failed", cause);

    return err("failed");
  }

  reservation.state = "committed";

  return ok(undefined);
}

async function write(
  reservation: Reservation,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<Result<void, "failed">> {
  if (reservation.state !== "open") {
    logFailure(reservation.dependencies, "write", "not_open");

    return err("failed");
  }

  if (signal.aborted) {
    throw abortError();
  }

  reservation.state = "writing";

  const result = commit(reservation, bytes, signal);

  reservation.writing = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

async function discard(reservation: Reservation): Promise<void> {
  if (reservation.state === "open") {
    reservation.state = "discarded";
    await closeQuietly(reservation.dependencies, "discard", reservation.file);
  } else {
    await reservation.writing;
  }

  if (reservation.state === "committed") {
    return;
  }

  reservation.state = "discarded";
  await removeIfOwned(reservation.dependencies, reservation.path, reservation.identity);
}

function reservedFile(reservation: Reservation): ReservedAudioFile {
  return {
    write: async (bytes: Uint8Array, signal: AbortSignal): Promise<Result<void, "failed">> =>
      write(reservation, bytes, signal),
    discard: async (): Promise<void> => {
      reservation.discarding ??= discard(reservation);

      return reservation.discarding;
    },
  };
}

/**
 * Proves the file just created is a regular file and is what `path` names now. On any doubt it
 * closes the file and removes nothing: what is at the path may not be ours.
 */
async function verifyCreated(
  dependencies: Dependencies,
  path: string,
  file: OpenAudioFile,
): Promise<FileIdentity | null> {
  try {
    const created = await file.stat();
    const entry = await dependencies.fs.entryAt(path);

    if (created.regular && entry !== null && sameIdentity(entry.identity, created.identity)) {
      return created.identity;
    }

    logFailure(dependencies, "reserve", created.regular ? "not_at_path" : "not_regular_file");
  } catch (cause) {
    logFailure(dependencies, "reserve", "verify_failed", cause);
  }

  await closeQuietly(dependencies, "reserve", file);

  return null;
}

/** Creates `path` exclusively, so nothing is ever replaced, after refusing any existing entry. */
async function createOwned(
  dependencies: Dependencies,
  path: string,
): Promise<Result<OpenAudioFile, AudioReserveFailure>> {
  try {
    // `wx` already refuses an existing name, but on Windows it follows a dangling symlink and
    // creates its target; refusing any entry first, symlinks included, keeps D2 on both platforms.
    if ((await dependencies.fs.entryAt(path)) !== null) {
      return err("exists");
    }

    return ok(await dependencies.fs.createExclusive(path));
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") {
      return err("exists");
    }

    logFailure(dependencies, "reserve", "create_failed", cause);

    return err("failed");
  }
}

async function reserve(
  dependencies: Dependencies,
  path: string,
  signal: AbortSignal,
): Promise<Result<ReservedAudioFile, AudioReserveFailure>> {
  if (signal.aborted) {
    throw abortError();
  }

  const created = await createOwned(dependencies, path);

  if (!created.ok) {
    return created;
  }

  const file = created.value;
  const identity = await verifyCreated(dependencies, path, file);

  if (identity === null) {
    return err("failed");
  }

  const reservation: Reservation = {
    dependencies,
    path,
    file,
    identity,
    state: "open",
    writing: Promise.resolve(),
    discarding: null,
  };

  // Cancelled while the file was being created: nothing may stay behind.
  if (signal.aborted) {
    await discard(reservation);

    throw abortError();
  }

  return ok(reservedFile(reservation));
}

/**
 * `AudioFiles` on the local filesystem. Input: opened read-only (symlinks followed: the path is the
 * CLI user's), then judged by the open handle — a regular file, read in bounded chunks, never more
 * than `maxBytes + 1` bytes into memory. Output: created exclusively with mode 0o600, owned by its
 * identity (device and inode), written, fsynced, and closed; the successful close is the commit
 * point. Paths, contents, and error messages are never logged — only a system error code.
 */
export function createLocalAudioFiles(options: LocalAudioFilesOptions): AudioFiles {
  const dependencies: Dependencies = {
    logger: options.logger,
    fs: options.fileSystem ?? nodeAudioFileSystem,
  };

  return {
    read: async (path: string, maxBytes: number, signal: AbortSignal) =>
      readAudio(dependencies, path, maxBytes, signal),
    reserve: async (path: string, signal: AbortSignal) => reserve(dependencies, path, signal),
  };
}
