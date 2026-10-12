import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { z } from "zod";
import { err, ok, type Result } from "../../domain/result.js";

/** What `lstat` says about a path, never following a symbolic link. */
export interface FileIdentity {
  /** With `ino`, names the file itself: two hard links to one file share both. */
  readonly dev: bigint;
  readonly ino: bigint;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  /** Last modification, in milliseconds since the epoch. */
  readonly modifiedMs: number;
}

export interface DirectoryEntry {
  readonly name: string;
  /** A regular file: not a directory, a symbolic link, or anything else. */
  readonly isFile: boolean;
  /** A real directory, not a link to one. */
  readonly isDirectory: boolean;
}

/** The filesystem steps the stores take. Tests replace one to reach a branch a real disk cannot. */
export interface NoteFiles {
  makeDirectory(path: string): Promise<void>;
  /** Creates one directory exclusively: fails with `EEXIST` when `path` exists. */
  claimDirectory(path: string): Promise<void>;
  /** Removes a directory only if it is empty: fails with `ENOTEMPTY` otherwise. */
  removeDirectory(path: string): Promise<void>;
  /** Creates `path` exclusively, writes `data`, and fsyncs it before returning. */
  writeSynced(path: string, data: string, signal: AbortSignal): Promise<void>;
  /** Creates an empty file exclusively: fails with `EEXIST` when one is there. */
  createMarker(path: string): Promise<void>;
  /** Fails with `EEXIST` when `newPath` exists. A failed link creates nothing. */
  link(existingPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  /**
   * Gives a file a new name that nothing else uses. Atomic: of several callers renaming one name,
   * one succeeds and the others fail with `ENOENT`.
   */
  rename(fromPath: string, toPath: string): Promise<void>;
  /**
   * The file's bytes, or `too_large` (unread) when it is bigger than `maxBytes`. Fails, without
   * reading, when the path is not a regular file or is a symbolic link.
   */
  readAtMost(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, "too_large">>;
  /** `undefined` when nothing is there; the link itself, not its target, when it is one. */
  identityOf(path: string): Promise<FileIdentity | undefined>;
  /** Entries of one directory, typed without following links; `[]` when it does not exist. */
  listDirectory(path: string): Promise<readonly DirectoryEntry[]>;
}

/** POSIX only; Windows has neither, and its files cannot be FIFOs or links we would follow here. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const errnoSchema = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,32}$/) });

/** Only a short system error code (`ENOENT`) is ever kept: messages carry absolute paths. */
export function errorCodeOf(cause: unknown): string {
  const parsed = errnoSchema.safeParse(cause);

  return parsed.success ? parsed.data.code : "unknown";
}

function isMissing(cause: unknown): boolean {
  return errorCodeOf(cause) === "ENOENT";
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
  createMarker: async (path: string): Promise<void> => {
    const handle = await open(path, "wx", 0o600);

    await handle.close();
  },
  claimDirectory: async (path: string): Promise<void> => {
    await mkdir(path, { mode: 0o700 });
  },
  removeDirectory: async (path: string): Promise<void> => rmdir(path),
  link: async (existingPath: string, newPath: string): Promise<void> => link(existingPath, newPath),
  remove: async (path: string): Promise<void> => unlink(path),
  rename: async (fromPath: string, toPath: string): Promise<void> => rename(fromPath, toPath),
  readAtMost: async (
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, "too_large">> => {
    // Not following links and not blocking, so a planted link or FIFO cannot redirect or hang the read.
    const handle = await open(path, READ_FLAGS);

    try {
      const stats = await handle.stat();

      if (!stats.isFile()) {
        throw Object.assign(new Error("Not a regular file."), { code: "EINVAL" });
      }

      if (stats.size > maxBytes) {
        return err("too_large");
      }

      // ponytail: a file that grows after stat is read whole; only a local process can do that,
      // and the content is still schema-validated. Bounded reads if DATA_DIR stops being trusted.
      return ok(await handle.readFile({ signal }));
    } finally {
      await handle.close();
    }
  },
  identityOf: async (path: string): Promise<FileIdentity | undefined> => {
    try {
      const stats = await lstat(path, { bigint: true });

      return {
        dev: stats.dev,
        ino: stats.ino,
        isFile: stats.isFile(),
        isDirectory: stats.isDirectory(),
        modifiedMs: Number(stats.mtimeMs),
      };
    } catch (cause) {
      if (isMissing(cause)) {
        return undefined;
      }

      throw cause;
    }
  },
  listDirectory: async (path: string): Promise<readonly DirectoryEntry[]> => {
    try {
      const entries = await readdir(path, { withFileTypes: true });

      return entries.map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
      }));
    } catch (cause) {
      if (isMissing(cause)) {
        return [];
      }

      throw cause;
    }
  },
};

/** True when both paths name one file: hard links to the same data. */
export function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
