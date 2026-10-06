import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileNoteStore,
  type NoteFiles,
  nodeNoteFiles,
} from "../../../../src/adapters/persistence/file-note-store.js";
import type { NoteDraft, NoteStore } from "../../../../src/ports/note-store.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";

/** SHA-256("0123456789abcdef") = 9f9f5111f7b27a781f1f1ddde5ebc2dd2b796bfc…, checked with sha256sum. */
const KEY = "0123456789abcdef";

const NOTE_ID = "9f9f5111f7b27a781f1f1ddde5ebc2dd";

const TEXT = "sk-note-text: buy milk";

const CREATED_AT = new Date("2026-01-02T03:04:05.000Z");

let root: string;

let directory: string;

let logger: RecordingLogger;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "file-note-store-"));
  directory = join(root, "notes");
  logger = createRecordingLogger();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function store(files?: NoteFiles): NoteStore {
  return createFileNoteStore(
    files === undefined ? { directory, logger } : { directory, logger, files },
  );
}

function draft(idempotencyKey = KEY, text = TEXT): NoteDraft {
  return { idempotencyKey, text, createdAt: CREATED_AT };
}

function live(): AbortSignal {
  return new AbortController().signal;
}

function idFor(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32);
}

async function entries(): Promise<string[]> {
  return (await readdir(directory)).sort();
}

/** Writes a record file as if an earlier process (or a person) had left it there. */
async function plant(noteId: string, content: string | Uint8Array): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${noteId}.json`), content);
}

function record(overrides: Record<string, string> = {}): string {
  return JSON.stringify({
    noteId: NOTE_ID,
    idempotencyKey: KEY,
    text: TEXT,
    createdAt: CREATED_AT.toISOString(),
    ...overrides,
  });
}

/** No log entry may carry a path, the key, or note text. */
function expectSafeLogs(): void {
  const logged = JSON.stringify(logger.entries);

  expect(logged).not.toContain(root.replaceAll("\\", "\\\\"));
  expect(logged).not.toContain(root);
  expect(logged).not.toContain(KEY);
  expect(logged).not.toContain("sk-note-text");
}

function failingWith(code: string): () => Promise<never> {
  return async () => {
    throw Object.assign(new Error(`${code}: failed at ${root}${"/notes/x.json"}`), { code });
  };
}

describe("file note store: ids and records", () => {
  it("names the note after the first 16 bytes of SHA-256 of the key, in lowercase hex", async () => {
    const outcome = await store().create(draft(), live());

    expect(idFor(KEY)).toBe(NOTE_ID);
    expect(outcome).toEqual({
      status: "created",
      note: { id: NOTE_ID, text: TEXT, createdAt: CREATED_AT },
    });
    expect(await entries()).toEqual([`${NOTE_ID}.json`]);
  });

  it("gives keys that differ only in case different ids, so case-insensitive disks cannot merge them", async () => {
    const notes = store();

    await notes.create(draft("abcdefghijklmnop"), live());
    await notes.create(draft("ABCDEFGHIJKLMNOP"), live());

    expect(await entries()).toEqual(
      [`${idFor("abcdefghijklmnop")}.json`, `${idFor("ABCDEFGHIJKLMNOP")}.json`].sort(),
    );
  });

  it("stores the full key with the note and reads the note back", async () => {
    const notes = store();

    await notes.create(draft(), live());

    expect(JSON.parse(await readFile(join(directory, `${NOTE_ID}.json`), "utf8"))).toEqual({
      noteId: NOTE_ID,
      idempotencyKey: KEY,
      text: TEXT,
      createdAt: "2026-01-02T03:04:05.000Z",
    });
    expect(await notes.read(NOTE_ID, live())).toEqual({
      status: "found",
      note: { id: NOTE_ID, text: TEXT, createdAt: CREATED_AT },
    });
  });

  it("returns the stored note for a key that was already used, whatever the new text", async () => {
    const notes = store();

    await notes.create(draft(), live());

    const sameText = await notes.create(draft(), live());

    const otherText = await notes.create(
      { ...draft(KEY, "other"), createdAt: new Date(0) },
      live(),
    );

    for (const outcome of [sameText, otherText]) {
      expect(outcome).toEqual({
        status: "exists",
        note: { id: NOTE_ID, text: TEXT, createdAt: CREATED_AT },
      });
    }

    expect(await entries()).toEqual([`${NOTE_ID}.json`]);
  });

  it("creates two notes for two keys with the same text", async () => {
    const notes = store();

    await notes.create(draft("key-one-0123456789"), live());
    await notes.create(draft("key-two-0123456789"), live());

    expect(await entries()).toHaveLength(2);
  });

  it("replays a key after the store is recreated, as after a process restart", async () => {
    await store().create(draft(), live());

    const restarted = store();

    expect(await restarted.create(draft(), live())).toEqual(
      expect.objectContaining({ status: "exists" }),
    );
    expect(await restarted.read(NOTE_ID, live())).toEqual(
      expect.objectContaining({ status: "found" }),
    );
  });
});

describe("file note store: concurrency", () => {
  it("commits exactly one note for 50 concurrent creates with one key", async () => {
    const notes = store();

    const outcomes = await Promise.all(
      Array.from({ length: 50 }, () => notes.create(draft(), live())),
    );

    expect(outcomes.filter((outcome) => outcome.status === "created")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "exists")).toHaveLength(49);
    expect(await entries()).toEqual([`${NOTE_ID}.json`]);
  });

  it("lets every loser see the winner's note when 50 concurrent creates race with different text", async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 50 }, (_, index) => store().create(draft(KEY, `text ${index}`), live())),
    );

    const winner = outcomes.find((outcome) => outcome.status === "created");
    const texts = new Set(outcomes.map((outcome) => ("note" in outcome ? outcome.note.text : "")));

    expect(winner).toBeDefined();
    expect(texts.size).toBe(1);
    expect(await entries()).toEqual([`${NOTE_ID}.json`]);
  });
});

describe("file note store: reading", () => {
  it("reports not_found when nothing was ever written", async () => {
    expect(await store().read(NOTE_ID, live())).toEqual({ status: "not_found" });
  });

  it("reports not_found for a missing note in an existing directory", async () => {
    const notes = store();

    await notes.create(draft(), live());

    expect(await notes.read(idFor("another-key-0123456"), live())).toEqual({ status: "not_found" });
  });

  it.each([
    "../outside",
    "..\\outside",
    `${"0".repeat(32)}/../../outside`,
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    "A".repeat(32),
    "",
  ])("never touches the filesystem for the id %j", async (noteId) => {
    const read: string[] = [];

    await writeFile(join(root, "outside.json"), record());

    const notes = store({
      ...nodeNoteFiles,
      readAtMost: async (path, maxBytes, signal) => {
        read.push(path);

        return nodeNoteFiles.readAtMost(path, maxBytes, signal);
      },
    });

    expect(await notes.read(noteId, live())).toEqual({ status: "not_found" });
    expect(read).toEqual([]);
  });
});

describe("file note store: committed records that fail validation", () => {
  const OTHER_KEY = "other-key-0123456789";

  it.each([
    ["invalid JSON", "{not json", "invalid_json"],
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), "invalid_json"],
    ["a JSON array", "[]", "invalid_record"],
    ["an extra property", record({ path: "/tmp/x" }), "invalid_record"],
    ["text that is too long", record({ text: "x".repeat(2_001) }), "invalid_record"],
    ["a malformed date", record({ createdAt: "yesterday" }), "invalid_record"],
    ["another note's id", record({ noteId: "f".repeat(32) }), "id_mismatch"],
    ["a key that does not hash to its id", record({ idempotencyKey: OTHER_KEY }), "key_mismatch"],
  ])("reports %s as unreadable, unchanged and unlogged", async (_label, content, problem) => {
    await plant(NOTE_ID, content);
    const before = await readFile(join(directory, `${NOTE_ID}.json`));

    expect(await store().read(NOTE_ID, live())).toEqual({ status: "unreadable" });
    expect(await store().create(draft(), live())).toEqual({ status: "unreadable" });
    expect(await readFile(join(directory, `${NOTE_ID}.json`))).toEqual(before);
    expect(await entries()).toEqual([`${NOTE_ID}.json`]);
    expect(logger.entries.map((entry) => [entry.level, entry.message, entry.fields])).toEqual([
      ["error", "note_store.unreadable", { operation: "read", noteId: NOTE_ID, problem }],
      ["error", "note_store.unreadable", { operation: "create", noteId: NOTE_ID, problem }],
    ]);
    expectSafeLogs();
    expect(JSON.stringify(logger.entries)).not.toContain(OTHER_KEY);
  });

  it("refuses a record over 64 KiB without parsing it", async () => {
    await plant(NOTE_ID, " ".repeat(65_537 - record().length) + record());

    expect(await store().read(NOTE_ID, live())).toEqual({ status: "unreadable" });
    expect(logger.entries[0]?.fields).toEqual(expect.objectContaining({ problem: "too_large" }));
  });

  it("reads a valid record of exactly 64 KiB", async () => {
    await plant(NOTE_ID, " ".repeat(65_536 - record().length) + record());

    expect(await store().read(NOTE_ID, live())).toEqual(
      expect.objectContaining({ status: "found" }),
    );
  });
});

describe("file note store: storage failures", () => {
  it("reports unavailable when the directory cannot be created, and logs only the error code", async () => {
    await writeFile(join(root, "blocker"), "");
    directory = join(root, "blocker", "notes");

    expect(await store().create(draft(), live())).toEqual({ status: "unavailable" });
    expect(logger.entries).toEqual([
      {
        level: "warn",
        message: "note_store.unavailable",
        fields: {
          operation: "create",
          phase: "mkdir",
          errorCode: expect.stringMatching(/^E[A-Z]+$/),
        },
      },
    ]);
    expectSafeLogs();
  });

  it.each([
    ["write", { writeSynced: failingWith("EIO") }, "EIO"],
    ["link", { link: failingWith("EPERM") }, "EPERM"],
  ] satisfies [string, Partial<NoteFiles>, string][])(
    "reports unavailable when the %s step fails, leaving no note and no temp file",
    async (phase, override, errorCode) => {
      expect(await store({ ...nodeNoteFiles, ...override }).create(draft(), live())).toEqual({
        status: "unavailable",
      });
      expect(await entries()).toEqual([]);
      expect(logger.entries).toEqual([
        expect.objectContaining({
          message: "note_store.unavailable",
          fields: { operation: "create", phase, errorCode },
        }),
      ]);
      expectSafeLogs();
    },
  );

  it("reports unavailable when the note is a directory and cannot be read", async () => {
    await mkdir(join(directory, `${NOTE_ID}.json`), { recursive: true });

    expect(await store().read(NOTE_ID, live())).toEqual({ status: "unavailable" });
    expect(await store().create(draft(), live())).toEqual({ status: "unavailable" });
    expect(await entries()).toEqual([`${NOTE_ID}.json`]);
    expectSafeLogs();
  });

  it("reports unavailable, not created, when the existing record cannot be read after EEXIST", async () => {
    await store().create(draft(), live());

    const outcome = await store({ ...nodeNoteFiles, readAtMost: failingWith("EACCES") }).create(
      draft(),
      live(),
    );

    expect(outcome).toEqual({ status: "unavailable" });
    expect(logger.entries).toEqual([
      expect.objectContaining({
        fields: { operation: "create", phase: "read", errorCode: "EACCES" },
      }),
    ]);
  });

  it("reports unavailable when the record vanishes between EEXIST and the read", async () => {
    const outcome = await store({ ...nodeNoteFiles, link: failingWith("EEXIST") }).create(
      draft(),
      live(),
    );

    expect(outcome).toEqual({ status: "unavailable" });
    expect(logger.entries).toEqual([
      expect.objectContaining({
        fields: { operation: "create", phase: "read", errorCode: "ENOENT" },
      }),
    ]);
    expect(await entries()).toEqual([]);
  });

  it("keeps a committed note created when removing the temp file fails", async () => {
    const outcome = await store({ ...nodeNoteFiles, remove: failingWith("EBUSY") }).create(
      draft(),
      live(),
    );

    expect(outcome).toEqual(expect.objectContaining({ status: "created" }));
    expect(logger.entries).toEqual([
      {
        level: "warn",
        message: "note_store.temp_cleanup_failed",
        fields: { errorCode: "EBUSY" },
      },
    ]);
    expectSafeLogs();
  });

  it("logs an unknown error code when a failure carries none", async () => {
    const notes = store({
      ...nodeNoteFiles,
      writeSynced: async () => {
        throw new Error("no code");
      },
    });

    expect(await notes.create(draft(), live())).toEqual({ status: "unavailable" });
    expect(logger.entries[0]?.fields).toEqual(expect.objectContaining({ errorCode: "unknown" }));
  });
});

describe("file note store: cancellation", () => {
  it("rejects without touching the disk when the signal is already aborted", async () => {
    const notes = store();

    await expect(notes.create(draft(), AbortSignal.abort("sk-reason"))).rejects.toMatchObject({
      name: "AbortError",
      message: "The note store operation was aborted.",
    });
    await expect(notes.read(NOTE_ID, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stays an abort, not unavailable, when the signal aborts during the write", async () => {
    const caller = new AbortController();

    const notes = store({
      ...nodeNoteFiles,
      writeSynced: async (path, data, signal) => {
        caller.abort();

        return nodeNoteFiles.writeSynced(path, data, signal);
      },
    });

    await expect(notes.create(draft(), caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await entries()).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  it("does not link when the signal aborts after the write", async () => {
    const caller = new AbortController();

    const notes = store({
      ...nodeNoteFiles,
      writeSynced: async (path, data, signal) => {
        await nodeNoteFiles.writeSynced(path, data, signal);
        caller.abort();
      },
    });

    await expect(notes.create(draft(), caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await entries()).toEqual([]);
  });

  it("stays an abort when the link fails while the signal aborts", async () => {
    const caller = new AbortController();
    const failLink = failingWith("EPERM");

    const notes = store({
      ...nodeNoteFiles,
      link: async () => {
        caller.abort();

        return failLink();
      },
    });

    await expect(notes.create(draft(), caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await entries()).toEqual([]);
  });

  it("ignores an abort that arrives after the commit point", async () => {
    const caller = new AbortController();

    const notes = store({
      ...nodeNoteFiles,
      link: async (existingPath, newPath) => {
        await nodeNoteFiles.link(existingPath, newPath);
        caller.abort();
      },
    });

    expect(await notes.create(draft(), caller.signal)).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await entries()).toEqual([`${NOTE_ID}.json`]);
  });
});

describe.skipIf(process.platform === "win32")("file note store: POSIX permissions", () => {
  it("creates the directory owner-only and note files owner-read/write", async () => {
    await store().create(draft(), live());

    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, `${NOTE_ID}.json`))).mode & 0o777).toBe(0o600);
  });
});
