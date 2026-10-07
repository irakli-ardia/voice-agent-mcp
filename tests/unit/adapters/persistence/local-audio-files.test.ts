import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AudioFileSystem,
  createLocalAudioFiles,
  nodeAudioFileSystem,
  type OpenAudioFile,
} from "../../../../src/adapters/persistence/local-audio-files.js";
import { MAX_AUDIO_BYTES } from "../../../../src/domain/audio-format.js";
import type { Result } from "../../../../src/domain/result.js";
import type { AudioFiles, ReservedAudioFile } from "../../../../src/ports/audio-files.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";

const SENTINEL = "SENTINEL-4b2d";

/** Whether this machine lets an unprivileged process create symlinks (Windows needs Developer Mode). */
async function symlinksSupported(): Promise<boolean> {
  const probe = await mkdtemp(join(tmpdir(), "audio-files-symlink-"));

  try {
    await writeFile(join(probe, "target"), "x");
    await symlink(join(probe, "target"), join(probe, "link"), "file");

    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

const SYMLINKS = await symlinksSupported();

const WINDOWS = process.platform === "win32";

let root: string;

let logger: RecordingLogger;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), `audio-files-${SENTINEL}-`));
  logger = createRecordingLogger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Overrides {
  /** Replaces filesystem steps; unspecified steps are the real ones. */
  readonly fs?: Partial<AudioFileSystem>;
  /** Replaces steps of every opened file; it receives the real file. */
  readonly file?: (real: OpenAudioFile) => Partial<OpenAudioFile>;
}

interface Subject {
  readonly files: AudioFiles;
  /** Files opened and closed through the adapter, so tests can prove no handle leaks. */
  readonly handles: { opened: number; closed: number };
}

/** The adapter on the real filesystem, with optional steps replaced for unreachable branches. */
function subject(overrides: Overrides = {}): Subject {
  const handles = { opened: 0, closed: 0 };
  const steps = { ...nodeAudioFileSystem, ...overrides.fs };

  const track = (real: OpenAudioFile): OpenAudioFile => {
    handles.opened += 1;

    const file = { ...real, ...overrides.file?.(real) };

    return {
      ...file,
      close: async (): Promise<void> => {
        handles.closed += 1;
        await file.close();
      },
    };
  };

  const fileSystem: AudioFileSystem = {
    ...steps,
    openForReading: async (path) => track(await steps.openForReading(path)),
    createExclusive: async (path) => track(await steps.createExclusive(path)),
  };

  return { files: createLocalAudioFiles({ logger, fileSystem }), handles };
}

function live(): AbortSignal {
  return new AbortController().signal;
}

/** A close that releases the real handle and then reports a failure, as a failing close can. */
function failingClose(real: OpenAudioFile): Partial<OpenAudioFile> {
  return {
    close: async (): Promise<void> => {
      await real.close();

      throw systemError("EIO");
    },
  };
}

/** A filesystem error as Node raises it: a code, and a message with an absolute path. */
function systemError(code: string): Error {
  return Object.assign(new Error(`${code}: failed, open 'C:\\Users\\${SENTINEL}\\a.wav'`), {
    code,
  });
}

function bytesOf(length: number, seed = 7): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + seed) % 256);
}

async function reserveOk(files: AudioFiles, path: string): Promise<ReservedAudioFile> {
  const reserved = await files.reserve(path, live());

  if (!reserved.ok) {
    throw new Error(`reserve failed: ${reserved.error}`);
  }

  return reserved.value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch {
    return false;
  }
}

function problems(): readonly unknown[] {
  return logger.entries.map(({ fields: { problem } }) => problem);
}

describe("local audio files: reading", () => {
  it("returns the exact bytes of a regular file under the limit", async () => {
    const path = join(root, "question.wav");
    const content = bytesOf(200_000);

    await writeFile(path, content);

    const { files, handles } = subject();

    expect(await files.read(path, 300_000, live())).toEqual({ ok: true, value: content });
    expect(handles).toEqual({ opened: 1, closed: 1 });
  });

  it.each([
    ["exactly at", 0, true],
    ["one byte over", 1, false],
  ])("reads a file %s the limit correctly", async (_name, extra, accepted) => {
    const path = join(root, "question.wav");
    const content = bytesOf(1_000 + extra);

    await writeFile(path, content);

    const { files, handles } = subject();
    const result = await files.read(path, 1_000, live());

    expect(result).toEqual(
      accepted ? { ok: true, value: content } : { ok: false, error: "too_large" },
    );
    expect(handles).toEqual({ opened: 1, closed: 1 });
  });

  it.each([
    ["exactly MAX_AUDIO_BYTES", MAX_AUDIO_BYTES, true],
    ["MAX_AUDIO_BYTES + 1", MAX_AUDIO_BYTES + 1, false],
  ])("applies the application limit to a real %s file", async (_name, size, accepted) => {
    const path = join(root, "big.wav");

    await writeFile(path, new Uint8Array(size));

    const result = await subject().files.read(path, MAX_AUDIO_BYTES, live());

    expect(result.ok ? result.value.byteLength : result.error).toBe(
      accepted ? MAX_AUDIO_BYTES : "too_large",
    );
  });

  it("refuses an oversized file from its handle size without reading it", async () => {
    const path = join(root, "big.wav");
    let reads = 0;

    await writeFile(path, bytesOf(5_000));

    const { files } = subject({
      file: (real) => ({
        read: async (buffer, length) => {
          reads += 1;

          return real.read(buffer, length);
        },
      }),
    });

    expect(await files.read(path, 4_999, live())).toEqual({ ok: false, error: "too_large" });
    expect(reads).toBe(0);
  });

  it.each([
    ["grew after it was opened", 10n],
    ["reports size 0, as /proc files do", 0n],
  ])("stops reading at limit + 1 when a file %s", async (_name, reportedSize) => {
    const path = join(root, "growing.wav");
    let bytesRead = 0;

    await writeFile(path, bytesOf(300_000));

    const { files, handles } = subject({
      file: (real) => ({
        stat: async () => ({ ...(await real.stat()), size: reportedSize }),
        read: async (buffer, length) => {
          const count = await real.read(buffer, length);

          bytesRead += count;

          return count;
        },
      }),
    });

    expect(await files.read(path, 100_000, live())).toEqual({ ok: false, error: "too_large" });
    expect(bytesRead).toBe(100_001);
    expect(handles).toEqual({ opened: 1, closed: 1 });
  });

  it("returns an empty file as zero bytes; format policy belongs to the domain", async () => {
    const path = join(root, "empty.wav");

    await writeFile(path, new Uint8Array(0));

    expect(await subject().files.read(path, 1_000, live())).toEqual({
      ok: true,
      value: new Uint8Array(0),
    });
  });

  it("does not trust the extension, and returns every regular file's bytes as they are", async () => {
    const path = join(root, "notes.txt");

    await writeFile(path, "not audio");

    const result = await subject().files.read(path, 1_000, live());

    expect(result.ok && new TextDecoder().decode(result.value)).toBe("not audio");
  });

  it("rejects a directory as unreadable, judged by the open handle", async () => {
    const path = join(root, "folder.wav");

    await mkdir(path);

    const { files, handles } = subject();

    expect(await files.read(path, 1_000, live())).toEqual({ ok: false, error: "unreadable" });
    expect(handles.opened).toBe(handles.closed);
    expect(await stat(path)).toBeTruthy();
  });

  it("reports a missing file as unreadable, logging only the error code", async () => {
    const path = join(root, "missing.wav");

    expect(await subject().files.read(path, 1_000, live())).toEqual({
      ok: false,
      error: "unreadable",
    });
    expect(logger.entries).toEqual([
      {
        level: "warn",
        message: "audio_file.failed",
        fields: { operation: "read", problem: "open_failed", errorCode: "ENOENT" },
      },
    ]);
  });

  it("closes the handle and reports unreadable when a read fails midway", async () => {
    const path = join(root, "question.wav");

    await writeFile(path, bytesOf(200_000));

    const { files, handles } = subject({
      file: () => ({
        read: async () => Promise.reject(systemError("EIO")),
      }),
    });

    expect(await files.read(path, 300_000, live())).toEqual({ ok: false, error: "unreadable" });
    expect(handles).toEqual({ opened: 1, closed: 1 });
    expect(problems()).toEqual(["read_failed"]);
  });

  it("logs a thrown value that is not a system error as unknown, never its text", async () => {
    const path = join(root, "question.wav");

    await writeFile(path, bytesOf(100));

    const { files } = subject({
      file: () => ({ read: async () => Promise.reject(`${SENTINEL}`) }),
    });

    expect(await files.read(path, 1_000, live())).toEqual({ ok: false, error: "unreadable" });
    expect(logger.entries.map(({ fields }) => fields)).toEqual([
      { operation: "read", problem: "read_failed", errorCode: "unknown" },
    ]);
  });

  it("keeps a completed read when closing the input fails, and logs the close", async () => {
    const path = join(root, "question.wav");
    const content = bytesOf(100);

    await writeFile(path, content);

    const { files } = subject({ file: failingClose });

    expect(await files.read(path, 1_000, live())).toEqual({ ok: true, value: content });
    expect(problems()).toEqual(["close_failed"]);
  });

  it("rejects for a caller that already cancelled, opening nothing", async () => {
    const controller = new AbortController();

    controller.abort();

    const { files, handles } = subject();

    await expect(files.read(join(root, "a.wav"), 1_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(handles.opened).toBe(0);
  });

  it("rejects when the caller cancels between chunks, closing the handle", async () => {
    const path = join(root, "question.wav");
    const controller = new AbortController();

    await writeFile(path, bytesOf(300_000));

    const { files, handles } = subject({
      file: (real) => ({
        read: async (buffer, length) => {
          controller.abort();

          return real.read(buffer, length);
        },
      }),
    });

    await expect(files.read(path, 1_000_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "The audio file operation was aborted.",
    });
    expect(handles).toEqual({ opened: 1, closed: 1 });
  });

  it("rejects when the caller cancelled while the file was opening", async () => {
    const controller = new AbortController();

    const { files } = subject({
      fs: {
        openForReading: async () => {
          controller.abort();

          return Promise.reject(systemError("ENOENT"));
        },
      },
    });

    await expect(files.read(join(root, "a.wav"), 1_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe.skipIf(!SYMLINKS)("local audio files: reading through symlinks", () => {
  it("follows a symlink to a regular file: the path is the CLI user's own", async () => {
    const target = join(root, "target.wav");
    const content = bytesOf(64);

    await writeFile(target, content);
    await symlink(target, join(root, "link.wav"), "file");

    expect(await subject().files.read(join(root, "link.wav"), 1_000, live())).toEqual({
      ok: true,
      value: content,
    });
  });

  it("rejects a symlink to a directory, judged by the opened target", async () => {
    await mkdir(join(root, "folder"));
    await symlink(join(root, "folder"), join(root, "link.wav"), "junction");

    expect(await subject().files.read(join(root, "link.wav"), 1_000, live())).toEqual({
      ok: false,
      error: "unreadable",
    });
  });

  it("rejects a dangling symlink", async () => {
    await symlink(join(root, "missing.wav"), join(root, "link.wav"), "file");

    expect(await subject().files.read(join(root, "link.wav"), 1_000, live())).toEqual({
      ok: false,
      error: "unreadable",
    });
  });
});

describe.skipIf(WINDOWS)("local audio files: POSIX special files", () => {
  it("rejects a FIFO without blocking on the open", async () => {
    const fifo = join(root, "pipe.wav");

    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(await subject().files.read(fifo, 1_000, live())).toEqual({
      ok: false,
      error: "unreadable",
    });
    expect(problems()).toEqual(["not_regular_file"]);
  });

  it("rejects a character device without reading from it", async () => {
    expect(await subject().files.read("/dev/zero", 1_000, live())).toEqual({
      ok: false,
      error: "unreadable",
    });
  });
});

describe.skipIf(!WINDOWS)("local audio files: Windows device paths", () => {
  it("rejects the NUL device as input: a character device, not a regular file", async () => {
    expect(await subject().files.read(String.raw`\\.\NUL`, 1_000, live())).toEqual({
      ok: false,
      error: "unreadable",
    });
    expect(problems()).toEqual(["not_regular_file"]);
  });

  it("refuses the NUL device as output: something already has that name", async () => {
    expect(await subject().files.reserve(String.raw`\\.\NUL`, live())).toEqual({
      ok: false,
      error: "exists",
    });
  });

  it("refuses a device opened through the exclusive create, closing and removing nothing", async () => {
    let removed = 0;

    const { files, handles } = subject({
      fs: {
        // Lets the device through the pre-check, so the post-create check must catch it.
        entryAt: async (path) =>
          path.endsWith("NUL") && handles.opened === 0 ? null : nodeAudioFileSystem.entryAt(path),
        remove: async () => {
          removed += 1;
        },
      },
    });

    expect(await files.reserve(String.raw`\\.\NUL`, live())).toEqual({
      ok: false,
      error: "failed",
    });
    expect(handles).toEqual({ opened: 1, closed: 1 });
    expect(removed).toBe(0);
    expect(problems()).toEqual(["not_regular_file"]);
  });
});

describe("local audio files: reservation", () => {
  it("creates an empty file it holds open, before anything is written", async () => {
    const path = join(root, "answer.wav");
    const { files, handles } = subject();

    const reserved = await reserveOk(files, path);

    expect(await readFile(path)).toHaveLength(0);
    expect(handles).toEqual({ opened: 1, closed: 0 });

    await reserved.discard();
  });

  it("refuses an existing file and leaves it unchanged", async () => {
    const path = join(root, "answer.wav");

    await writeFile(path, "keep me");

    expect(await subject().files.reserve(path, live())).toEqual({ ok: false, error: "exists" });
    expect(await readFile(path, "utf8")).toBe("keep me");
  });

  it("refuses an existing directory and leaves it unchanged", async () => {
    const path = join(root, "answer.wav");

    await mkdir(path);
    await writeFile(join(path, "inside"), "keep");

    expect(await subject().files.reserve(path, live())).toEqual({ ok: false, error: "exists" });
    expect(await readFile(join(path, "inside"), "utf8")).toBe("keep");
  });

  it("refuses a missing parent directory and creates no directory", async () => {
    const parent = join(root, "missing");

    expect(await subject().files.reserve(join(parent, "answer.wav"), live())).toEqual({
      ok: false,
      error: "failed",
    });
    expect(await exists(parent)).toBe(false);
    expect(logger.entries[0]?.fields).toEqual({
      operation: "reserve",
      problem: "create_failed",
      errorCode: "ENOENT",
    });
  });

  it("lets exactly one of many competing reservations win", async () => {
    const path = join(root, "answer.wav");
    const files = subject().files;

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => files.reserve(path, live())),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error === "exists")).toHaveLength(19);

    await Promise.all(
      results.map(async (result) => (result.ok ? result.value.discard() : undefined)),
    );
  });

  it("maps EEXIST from the exclusive create to exists, when the name appeared after the check", async () => {
    const path = join(root, "answer.wav");

    const { files } = subject({
      fs: {
        createExclusive: async () => {
          await writeFile(path, "raced in");

          return nodeAudioFileSystem.createExclusive(path);
        },
      },
    });

    expect(await files.reserve(path, live())).toEqual({ ok: false, error: "exists" });
    expect(await readFile(path, "utf8")).toBe("raced in");
  });

  it("refuses, and removes nothing, when the path no longer names the file it created", async () => {
    const path = join(root, "answer.wav");
    const moved = join(root, "moved.wav");

    const { files, handles } = subject({
      fs: {
        createExclusive: async (target) => {
          const created = await nodeAudioFileSystem.createExclusive(target);

          await rename(target, moved);
          await writeFile(target, "someone else's");

          return created;
        },
      },
    });

    expect(await files.reserve(path, live())).toEqual({ ok: false, error: "failed" });
    expect(await readFile(path, "utf8")).toBe("someone else's");
    expect(await exists(moved)).toBe(true);
    expect(handles).toEqual({ opened: 1, closed: 1 });
    expect(problems()).toEqual(["not_at_path"]);
  });

  it("refuses a created object that is not a regular file, closing it and removing nothing", async () => {
    const path = join(root, "answer.wav");

    const { files, handles } = subject({
      file: (real) => ({ stat: async () => ({ ...(await real.stat()), regular: false }) }),
    });

    expect(await files.reserve(path, live())).toEqual({ ok: false, error: "failed" });
    expect(handles).toEqual({ opened: 1, closed: 1 });
    expect(await exists(path)).toBe(true);
    expect(problems()).toEqual(["not_regular_file"]);
  });

  it("reports a failed pre-check as failed, creating nothing", async () => {
    const path = join(root, "answer.wav");

    const { files, handles } = subject({
      fs: { entryAt: async () => Promise.reject(systemError("EACCES")) },
    });

    expect(await files.reserve(path, live())).toEqual({ ok: false, error: "failed" });
    expect(handles.opened).toBe(0);
    expect(await exists(path)).toBe(false);
  });

  it("reports a failed verification as failed, closing the file", async () => {
    const path = join(root, "answer.wav");
    let checks = 0;

    const { files, handles } = subject({
      fs: {
        entryAt: async (target) => {
          checks += 1;

          return checks === 1
            ? nodeAudioFileSystem.entryAt(target)
            : Promise.reject(systemError("EIO"));
        },
      },
    });

    expect(await files.reserve(path, live())).toEqual({ ok: false, error: "failed" });
    expect(handles).toEqual({ opened: 1, closed: 1 });
    expect(problems()).toEqual(["verify_failed"]);
  });

  it("rejects for a caller that already cancelled, creating nothing", async () => {
    const controller = new AbortController();
    const path = join(root, "answer.wav");

    controller.abort();

    await expect(subject().files.reserve(path, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await exists(path)).toBe(false);
  });

  it("rejects and leaves nothing behind when the caller cancels while the file is created", async () => {
    const controller = new AbortController();
    const path = join(root, "answer.wav");

    const { files, handles } = subject({
      fs: {
        createExclusive: async (target) => {
          const created = await nodeAudioFileSystem.createExclusive(target);

          controller.abort();

          return created;
        },
      },
    });

    await expect(files.reserve(path, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await exists(path)).toBe(false);
    expect(handles).toEqual({ opened: 1, closed: 1 });
  });
});

describe("local audio files: paths the filesystem rejects outright", () => {
  it("reports a path with a NUL byte as unreadable input and a failed reservation", async () => {
    const path = join(root, "a b.wav");

    expect(await subject().files.read(path, 1_000, live())).toEqual({
      ok: false,
      error: "unreadable",
    });
    expect(await subject().files.reserve(path, live())).toEqual({ ok: false, error: "failed" });
    expect(logger.entries.map(({ fields }) => fields)).toEqual([
      { operation: "read", problem: "open_failed", errorCode: "ERR_INVALID_ARG_VALUE" },
      { operation: "reserve", problem: "create_failed", errorCode: "ERR_INVALID_ARG_VALUE" },
    ]);
  });
});

describe.skipIf(!SYMLINKS)("local audio files: reservation and symlinks", () => {
  it("refuses a dangling symlink and never creates its target (Windows would follow it)", async () => {
    const path = join(root, "answer.wav");
    const target = join(root, "elsewhere.wav");

    await symlink(target, path, "file");

    expect(await subject().files.reserve(path, live())).toEqual({ ok: false, error: "exists" });
    expect(await exists(target)).toBe(false);
  });

  it("refuses a symlink to an existing file and leaves the file unchanged", async () => {
    const path = join(root, "answer.wav");
    const target = join(root, "precious.wav");

    await writeFile(target, "precious");
    await symlink(target, path, "file");

    expect(await subject().files.reserve(path, live())).toEqual({ ok: false, error: "exists" });
    expect(await readFile(target, "utf8")).toBe("precious");
  });
});

describe.skipIf(WINDOWS)("local audio files: POSIX permissions", () => {
  it("creates the output with mode 0600", async () => {
    const path = join(root, "answer.wav");

    const reserved = await reserveOk(subject().files, path);

    expect((await stat(path)).mode & 0o777).toBe(0o600);

    await reserved.discard();
  });
});

describe("local audio files: commit", () => {
  it("persists exactly the bytes given, closing the file", async () => {
    const path = join(root, "answer.wav");
    const content = bytesOf(250_000);
    const { files, handles } = subject();
    const reserved = await reserveOk(files, path);

    expect(await reserved.write(content, live())).toEqual({ ok: true, value: undefined });
    expect(new Uint8Array(await readFile(path))).toEqual(content);
    expect(handles).toEqual({ opened: 1, closed: 1 });
  });

  it("commits zero bytes as an empty file: content policy is not the adapter's", async () => {
    const path = join(root, "answer.wav");
    const reserved = await reserveOk(subject().files, path);

    expect((await reserved.write(new Uint8Array(0), live())).ok).toBe(true);
    expect(await readFile(path)).toHaveLength(0);
  });

  it("does not report success until the data is synced and the file closed", async () => {
    const path = join(root, "answer.wav");
    const syncReached = Promise.withResolvers<void>();
    const syncGate = Promise.withResolvers<void>();
    let settled = false;

    const { files } = subject({
      file: (real) => ({
        sync: async () => {
          syncReached.resolve();
          await syncGate.promise;
          await real.sync();
        },
      }),
    });

    const reserved = await reserveOk(files, path);

    const writing = reserved.write(bytesOf(10), live()).then((result) => {
      settled = true;

      return result;
    });

    await syncReached.promise;

    expect(settled).toBe(false);

    syncGate.resolve();

    expect((await writing).ok).toBe(true);
  });

  it.each([
    ["writing", { writeAll: async () => Promise.reject(systemError("ENOSPC")) }, "write_failed"],
    ["syncing", { sync: async () => Promise.reject(systemError("EIO")) }, "write_failed"],
    ["closing", "close", "close_failed"],
  ] as const)("fails, without committing, when %s fails", async (_name, failing, problem) => {
    const path = join(root, "answer.wav");

    const { files, handles } = subject({
      file: (real) => (failing === "close" ? failingClose(real) : failing),
    });

    const reserved = await reserveOk(files, path);

    expect(await reserved.write(bytesOf(10), live())).toEqual({ ok: false, error: "failed" });
    expect(handles.closed).toBe(1);
    expect(problems()).toEqual([problem]);

    await reserved.discard();

    expect(await exists(path)).toBe(false);
  });

  it("rejects for a caller that already cancelled; the reservation stays for discard", async () => {
    const controller = new AbortController();
    const path = join(root, "answer.wav");
    const reserved = await reserveOk(subject().files, path);

    controller.abort();

    await expect(reserved.write(bytesOf(10), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await readFile(path)).toHaveLength(0);

    await reserved.discard();

    expect(await exists(path)).toBe(false);
  });

  it("rejects when the caller cancels during the write, and discard then removes the file", async () => {
    const controller = new AbortController();
    const path = join(root, "answer.wav");

    const { files, handles } = subject({
      file: (real) => ({
        writeAll: async (bytes, signal) => {
          controller.abort();

          return real.writeAll(bytes, signal);
        },
      }),
    });

    const reserved = await reserveOk(files, path);

    await expect(reserved.write(bytesOf(10), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "The audio file operation was aborted.",
    });
    expect(handles.closed).toBe(1);

    await reserved.discard();

    expect(await exists(path)).toBe(false);
  });

  it("finishes the commit when the caller cancels after the data is synced", async () => {
    const controller = new AbortController();
    const path = join(root, "answer.wav");
    const content = bytesOf(10);

    const { files } = subject({
      file: (real) => ({
        sync: async () => {
          await real.sync();
          controller.abort();
        },
      }),
    });

    const reserved = await reserveOk(files, path);

    expect(await reserved.write(content, controller.signal)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(new Uint8Array(await readFile(path))).toEqual(content);
  });

  it.each(["after a commit", "after a discard", "while a write is in progress"])(
    "refuses a second write %s",
    async (when) => {
      const path = join(root, "answer.wav");
      const gate = Promise.withResolvers<void>();

      const { files } = subject({
        file: (real) => ({
          sync: async () => {
            await gate.promise;
            await real.sync();
          },
        }),
      });

      const reserved = await reserveOk(files, path);
      let first: Promise<Result<void, "failed">> | undefined;

      if (when === "after a commit") {
        gate.resolve();
        await reserved.write(bytesOf(10, 1), live());
      } else if (when === "after a discard") {
        await reserved.discard();
      } else {
        first = reserved.write(bytesOf(10, 1), live());
      }

      expect(await reserved.write(bytesOf(10, 2), live())).toEqual({ ok: false, error: "failed" });

      gate.resolve();
      await first;

      expect(problems()).toContain("not_open");
    },
  );
});

describe("local audio files: discard and ownership", () => {
  it("removes an unwritten reservation and closes its handle", async () => {
    const path = join(root, "answer.wav");
    const { files, handles } = subject();
    const reserved = await reserveOk(files, path);

    await reserved.discard();

    expect(await exists(path)).toBe(false);
    expect(handles).toEqual({ opened: 1, closed: 1 });
  });

  it("is idempotent: repeated and concurrent discards remove once", async () => {
    const path = join(root, "answer.wav");
    let removals = 0;

    const { files, handles } = subject({
      fs: {
        remove: async (target) => {
          removals += 1;
          await nodeAudioFileSystem.remove(target);
        },
      },
    });

    const reserved = await reserveOk(files, path);

    await Promise.all([reserved.discard(), reserved.discard()]);
    await reserved.discard();

    expect(removals).toBe(1);
    expect(handles.closed).toBe(1);
    expect(logger.entries).toEqual([]);
  });

  it("never removes a committed file", async () => {
    const path = join(root, "answer.wav");
    const reserved = await reserveOk(subject().files, path);

    await reserved.write(bytesOf(10), live());
    await reserved.discard();
    await reserved.discard();

    expect(await readFile(path)).toHaveLength(10);
  });

  it("never removes a file that replaced the reservation at its path", async () => {
    const path = join(root, "answer.wav");
    const reserved = await reserveOk(subject().files, path);

    // Windows refuses to rename over a file this process holds open; unlinking it is allowed.
    await rm(path);
    await writeFile(path, "someone else's");
    await reserved.discard();

    expect(await readFile(path, "utf8")).toBe("someone else's");
    expect(problems()).toEqual(["not_owned"]);
  });

  it("never removes a directory that took the reservation's name", async () => {
    const path = join(root, "answer.wav");
    const reserved = await reserveOk(subject().files, path);

    await rename(path, join(root, "moved.wav"));
    await mkdir(path);
    await reserved.discard();

    expect((await stat(path)).isDirectory()).toBe(true);
    expect(await exists(join(root, "moved.wav"))).toBe(true);
    expect(problems()).toEqual(["not_owned"]);
  });

  it("does nothing when the reservation was already removed by someone else", async () => {
    const path = join(root, "answer.wav");
    const reserved = await reserveOk(subject().files, path);

    await rm(path);
    await reserved.discard();

    expect(await readdir(root)).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  it("waits for a write in progress: a write that commits keeps its file", async () => {
    const path = join(root, "answer.wav");
    const gate = Promise.withResolvers<void>();

    const { files } = subject({
      file: (real) => ({
        sync: async () => {
          await gate.promise;
          await real.sync();
        },
      }),
    });

    const reserved = await reserveOk(files, path);
    const writing = reserved.write(bytesOf(10), live());
    const discarding = reserved.discard();

    gate.resolve();

    expect((await writing).ok).toBe(true);
    await discarding;
    expect(await readFile(path)).toHaveLength(10);
  });

  it("waits for a write in progress: a write that fails is then removed", async () => {
    const path = join(root, "answer.wav");
    const gate = Promise.withResolvers<void>();

    const { files } = subject({
      file: () => ({
        sync: async () => {
          await gate.promise;

          throw systemError("EIO");
        },
      }),
    });

    const reserved = await reserveOk(files, path);
    const writing = reserved.write(bytesOf(10), live());
    const discarding = reserved.discard();

    expect(await exists(path)).toBe(true);

    gate.resolve();

    expect((await writing).ok).toBe(false);
    await discarding;
    expect(await exists(path)).toBe(false);
  });

  it.each([
    [
      "inspecting the path",
      { entryAt: async () => Promise.reject(systemError("EACCES")) },
      "inspect_failed",
    ],
    [
      "removing the file",
      { remove: async () => Promise.reject(systemError("EPERM")) },
      "remove_failed",
    ],
  ] as const)("resolves, and logs, when %s fails", async (_name, failing, problem) => {
    const path = join(root, "answer.wav");
    let armed = false;

    const { files } = subject({
      fs: {
        entryAt: async (target) =>
          armed && "entryAt" in failing ? failing.entryAt() : nodeAudioFileSystem.entryAt(target),
        remove: async (target) =>
          "remove" in failing ? failing.remove() : nodeAudioFileSystem.remove(target),
      },
    });

    const reserved = await reserveOk(files, path);

    armed = true;

    await expect(reserved.discard()).resolves.toBeUndefined();
    expect(problems()).toEqual([problem]);
  });

  it("treats a removal racing with someone else's removal as done", async () => {
    const path = join(root, "answer.wav");

    const { files } = subject({
      fs: {
        remove: async (target) => {
          await nodeAudioFileSystem.remove(target);

          throw systemError("ENOENT");
        },
      },
    });

    const reserved = await reserveOk(files, path);

    await reserved.discard();

    expect(await exists(path)).toBe(false);
    expect(logger.entries).toEqual([]);
  });

  it("closes the handle quietly when closing an unwritten reservation fails", async () => {
    const path = join(root, "answer.wav");

    const { files } = subject({ file: failingClose });
    const reserved = await reserveOk(files, path);

    await expect(reserved.discard()).resolves.toBeUndefined();
    expect(await exists(path)).toBe(false);
    expect(problems()).toEqual(["close_failed"]);
  });
});

describe("local audio files: production wiring", () => {
  it("uses the real filesystem when no steps are injected", async () => {
    const path = join(root, "answer.wav");
    const files = createLocalAudioFiles({ logger });
    const reserved = await reserveOk(files, path);

    expect((await reserved.write(bytesOf(32), live())).ok).toBe(true);
    expect(await files.read(path, 1_000, live())).toEqual({ ok: true, value: bytesOf(32) });
  });
});

describe("local audio files: privacy", () => {
  it("never logs a path, file content, or a system error message", async () => {
    const path = join(root, `${SENTINEL}.wav`);

    await writeFile(join(root, "input.wav"), `${SENTINEL} audio`);

    const { files } = subject({
      file: () => ({ sync: async () => Promise.reject(systemError("EIO")) }),
    });

    await files.read(join(root, `missing-${SENTINEL}.wav`), 1_000, live());
    await files.read(root, 1_000, live());

    const reserved = await reserveOk(files, path);

    await reserved.write(new TextEncoder().encode(`${SENTINEL} speech`), live());
    await files.reserve(join(root, "missing", `${SENTINEL}.wav`), live());

    const logged = JSON.stringify(logger.entries);

    expect(logger.entries.length).toBeGreaterThanOrEqual(4);
    expect(logged).not.toContain(SENTINEL);
    expect(logged).not.toContain(root);
    expect(logged).not.toContain("failed, open");
  });
});
