import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileNoteStore,
  type NoteFiles,
  nodeNoteFiles,
} from "../../../../src/adapters/persistence/file-note-store.js";
import { reconcileSlots } from "../../../../src/adapters/persistence/note-reconcile.js";
import { noteIdFor } from "../../../../src/adapters/persistence/note-record.js";
import {
  ROLL_FORWARD_AFTER_MS,
  TEMP_MAX_AGE_MS,
} from "../../../../src/adapters/persistence/note-slot-layout.js";
import type { CreateNoteOutcome, NoteDraft, NoteStore } from "../../../../src/ports/note-store.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";

const TEXT = "sk-note-text: quota test";

const CREATED_AT = new Date("2026-01-02T03:04:05.000Z");

/** Distinct, valid idempotency keys: 16 to 64 letters, digits, `-` and `_`. */
function key(label: string | number): string {
  return `quota-key-${String(label).padStart(6, "0")}`;
}

function draft(label: string | number, text = TEXT): NoteDraft {
  return { idempotencyKey: key(label), text, createdAt: CREATED_AT };
}

let root: string;

let notes: string;

let slots: string;

let logger: RecordingLogger;

let offsetMs: number;

/** The store's clock never moves by itself, so no assertion depends on how long a test took. */
let clockBase: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "note-quota-"));
  notes = join(root, "notes");
  slots = `${notes}.slots`;
  logger = createRecordingLogger();
  offsetMs = 0;
  clockBase = Date.now();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function open(maxNotes: number, files: NoteFiles = nodeNoteFiles): NoteStore {
  return createFileNoteStore({
    directory: notes,
    logger,
    maxNotes,
    files,
    now: () => clockBase + offsetMs,
  });
}

function live(): AbortSignal {
  return new AbortController().signal;
}

async function slotNames(): Promise<string[]> {
  const entries = await readdir(slots, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => Number(a) - Number(b));
}

/** Every note is the same file as some slot record: that is what backs it against the quota. */
async function expectEveryNoteBacked(): Promise<void> {
  const backing = new Set<string>();

  for (const slot of await slotNames()) {
    for (const record of await readdir(join(slots, slot))) {
      const stats = await lstat(join(slots, slot, record), { bigint: true });

      backing.add(`${stats.dev}:${stats.ino}`);
    }
  }

  for (const name of await noteFiles()) {
    const stats = await lstat(join(notes, name), { bigint: true });

    expect(backing.has(`${stats.dev}:${stats.ino}`)).toBe(true);
  }
}

/** The path of the one record in a slot. */
async function recordOf(index: number): Promise<string> {
  const [name] = await readdir(join(slots, String(index)));

  return join(slots, String(index), name ?? "missing");
}

const RECORD_ID = "aaaaaaaa-0000-4000-8000-000000000001";

async function noteFiles(): Promise<string[]> {
  return (await readdir(notes)).filter((name) => name.endsWith(".json")).sort();
}

function statuses(outcomes: readonly CreateNoteOutcome[]) {
  const counts: Record<string, number> = {};

  for (const outcome of outcomes) {
    counts[outcome.status] = (counts[outcome.status] ?? 0) + 1;
  }

  return counts;
}

function recordFor(label: string | number, text = TEXT): string {
  return JSON.stringify({
    noteId: noteIdFor(key(label)),
    idempotencyKey: key(label),
    text,
    createdAt: CREATED_AT.toISOString(),
  });
}

/** A note file as an earlier version of the store (one without slots) left it. */
async function plantLegacy(label: string | number): Promise<void> {
  await mkdir(notes, { recursive: true });
  await writeFile(join(notes, `${noteIdFor(key(label))}.json`), recordFor(label));
}

function expectSafeLogs(): void {
  const logged = JSON.stringify(logger.entries);

  expect(logged).not.toContain(root.replaceAll("\\", "\\\\"));
  expect(logged).not.toContain(root);
  expect(logged).not.toContain("quota-key");
  expect(logged).not.toContain("sk-note-text");
}

describe("note quota: the limit", () => {
  it("holds exactly the configured number of notes and refuses the next with a static outcome", async () => {
    const store = open(3);

    for (let index = 0; index < 3; index += 1) {
      expect(await store.create(draft(index), live())).toEqual(
        expect.objectContaining({ status: "created" }),
      );
    }

    expect(await store.create(draft(3), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toHaveLength(3);
    expect(await slotNames()).toEqual(["0", "1", "2"]);
    expect((await readdir(notes)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
  });

  it("logs the refusal with the limit only", async () => {
    const store = open(1);

    await store.create(draft(0), live());
    await store.create(draft(1), live());

    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "note_store.quota_exceeded",
      fields: { limit: 1 },
    });
    expectSafeLogs();
  });

  it("works with a limit of one", async () => {
    const store = open(1);

    expect(await store.create(draft(0), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await store.create(draft(1), live())).toEqual({ status: "quota_exceeded" });
  });

  it("leaves a refused note nowhere: not as a note, a slot, or a temp file", async () => {
    const store = open(2);

    await store.create(draft(0), live());
    await store.create(draft(1), live());
    await store.create(draft(2), live());

    expect(await noteFiles()).not.toContain(`${noteIdFor(key(2))}.json`);
    expect(await store.read(noteIdFor(key(2)), live())).toEqual({ status: "not_found" });
  });
});

describe("note quota: replays at the limit", () => {
  it("returns a note that already exists, however full the store is", async () => {
    const store = open(2);

    await store.create(draft(0), live());
    await store.create(draft(1), live());

    expect(await store.create(draft(0), live())).toEqual(
      expect.objectContaining({ status: "exists" }),
    );
    expect(await store.create(draft(1), live())).toEqual(
      expect.objectContaining({ status: "exists" }),
    );
    expect(await slotNames()).toHaveLength(2);
  });

  it("returns the stored note for a conflicting replay, so the caller can see the conflict", async () => {
    const store = open(1);

    await store.create(draft(0, "first text"), live());

    const outcome = await store.create(draft(0, "different text"), live());

    expect(outcome).toEqual({
      status: "exists",
      note: expect.objectContaining({ text: "first text" }),
    });
  });

  it("does not write a temp file or take a slot for a replay", async () => {
    const calls: string[] = [];

    const store = open(2, {
      ...nodeNoteFiles,
      writeSynced: async (path, data, signal) => {
        calls.push("write");

        return nodeNoteFiles.writeSynced(path, data, signal);
      },
      link: async (from, to) => {
        calls.push("link");

        return nodeNoteFiles.link(from, to);
      },
    });

    await store.create(draft(0), live());
    calls.length = 0;
    await store.create(draft(0), live());

    expect(calls).toEqual([]);
  });
});

describe("note quota: concurrency in one process", () => {
  it("never holds more than the limit when many creates with different keys race", async () => {
    const store = open(5);

    const outcomes = await Promise.all(
      Array.from({ length: 60 }, async (_, index) => store.create(draft(index), live())),
    );

    expect(statuses(outcomes)).toEqual({ created: 5, quota_exceeded: 55 });
    expect(await noteFiles()).toHaveLength(5);
    expect(await slotNames()).toHaveLength(5);
  });

  it("commits one note and one slot for many creates with the same key", async () => {
    const store = open(10);

    const outcomes = await Promise.all(
      Array.from({ length: 40 }, async () => store.create(draft("same"), live())),
    );

    expect(statuses(outcomes)).toEqual({ created: 1, exists: 39 });
    expect(await noteFiles()).toHaveLength(1);
    expect(await slotNames()).toHaveLength(1);
  });

  it("lets a same-key loser see the winner's note, or a full store, but never a second note", async () => {
    const store = open(2);

    await store.create(draft(0), live());

    const outcomes = await Promise.all(
      Array.from({ length: 30 }, async () => store.create(draft("late"), live())),
    );

    const counts = statuses(outcomes);

    expect(counts["created"]).toBe(1);
    expect((counts["exists"] ?? 0) + (counts["quota_exceeded"] ?? 0)).toBe(29);
    expect(await noteFiles()).toHaveLength(2);
    expect(await slotNames()).toHaveLength(2);
  });

  it("holds the limit when different keys race alongside replays", async () => {
    const store = open(4);

    await store.create(draft(0), live());

    const outcomes = await Promise.all([
      ...Array.from({ length: 30 }, async (_, index) => store.create(draft(index + 1), live())),
      ...Array.from({ length: 10 }, async () => store.create(draft(0), live())),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "created")).toHaveLength(3);
    expect(await noteFiles()).toHaveLength(4);
  });

  it("releases the slots of losing same-key writers with different text", async () => {
    const store = open(10);

    await Promise.all(
      Array.from({ length: 20 }, async (_, index) =>
        store.create(draft("conflict", `text ${index}`), live()),
      ),
    );

    expect(await noteFiles()).toHaveLength(1);
    expect(await slotNames()).toHaveLength(1);
  });
});

describe("note quota: no scan on a normal write", () => {
  it("lists directories only while the store is prepared, never per write", async () => {
    let listings = 0;

    const store = open(100, {
      ...nodeNoteFiles,
      listDirectory: async (path) => {
        // Looking inside the one slot just claimed is constant work; the notes and the slots are not.
        listings += path === notes || path === slots ? 1 : 0;

        return nodeNoteFiles.listDirectory(path);
      },
    });

    await store.create(draft(0), live());

    const afterPreparation = listings;

    for (let index = 1; index < 30; index += 1) {
      await store.create(draft(index), live());
    }

    expect(listings).toBe(afterPreparation);
  });

  it("prepares once for any number of concurrent first creates", async () => {
    let initialisations = 0;

    const store = open(100, {
      ...nodeNoteFiles,
      createMarker: async (path) => {
        initialisations += 1;

        return nodeNoteFiles.createMarker(path);
      },
    });

    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => store.create(draft(index), live())),
    );

    expect(initialisations).toBe(1);
  });

  it("reconciles a full store at most once in a while, however many creates it refuses", async () => {
    let listings = 0;

    const store = open(1, {
      ...nodeNoteFiles,
      listDirectory: async (path) => {
        listings += 1;

        return nodeNoteFiles.listDirectory(path);
      },
    });

    await store.create(draft(0), live());

    const before = listings;

    for (let index = 1; index <= 50; index += 1) {
      await store.create(draft(index), live());
    }

    // One reconcile lists the notes, the slots, and the one slot; later refusals list nothing.
    expect(listings - before).toBeLessThanOrEqual(3);
  });
});

describe("note quota: a full store", () => {
  it("does not walk every slot again for each refusal within a moment", async () => {
    let attempts = 0;

    const store = open(20, {
      ...nodeNoteFiles,
      claimDirectory: async (path) => {
        attempts += 1;

        return nodeNoteFiles.claimDirectory(path);
      },
    });

    for (let index = 0; index < 20; index += 1) {
      await store.create(draft(index), live());
    }

    const before = attempts;

    for (let index = 20; index < 60; index += 1) {
      await store.create(draft(index), live());
    }

    // One pass over 20 slots, plus one more after the single reconcile; not 40 passes.
    expect(attempts - before).toBeLessThanOrEqual(40);
  });

  it("tries again once the moment has passed, because a slot may have been freed", async () => {
    const store = open(1);

    await store.create(draft(0), live());
    expect(await store.create(draft(1), live())).toEqual({ status: "quota_exceeded" });

    // Another process freed the slot (a stale record is gone) and a moment passes.
    await rm(slots, { recursive: true, force: true });
    await mkdir(slots, { recursive: true });
    offsetMs += 2_000;

    expect(await store.create(draft(1), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
  });

  it("answers a key that was published while it looked for a slot as a replay, not as a full store", async () => {
    const store = open(1, {
      ...nodeNoteFiles,
      writeSynced: async (path, data, signal) => {
        await nodeNoteFiles.writeSynced(path, data, signal);
        // Another process published this very key just now (it holds the only slot).
        await mkdir(notes, { recursive: true });
        await writeFile(join(notes, `${noteIdFor(key(5))}.json`), recordFor(5));
      },
    });

    await mkdir(join(slots, "0"), { recursive: true });
    await writeFile(join(slots, "0", RECORD_ID), recordFor(5));

    expect(await store.create(draft(5), live())).toEqual(
      expect.objectContaining({ status: "exists" }),
    );
  });

  it("starts a new process looking for free slots where the last ones are, not at the beginning", async () => {
    const first = open(100);

    for (let index = 0; index < 40; index += 1) {
      await first.create(draft(index), live());
    }

    let attempts = 0;

    const restarted = open(100, {
      ...nodeNoteFiles,
      rename: async (from, to) => {
        attempts += 1;

        return nodeNoteFiles.rename(from, to);
      },
    });

    await restarted.create(draft(1_000), live());

    expect(attempts).toBe(1);
  });
});

describe("note quota: preparing the store", () => {
  it("tries again after a failed preparation, in the same store", async () => {
    let failures = 1;

    const store = open(5, {
      ...nodeNoteFiles,
      createMarker: async (path) => {
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error("interrupted"), { code: "EIO" });
        }

        return nodeNoteFiles.createMarker(path);
      },
    });

    expect(await store.create(draft(0), live())).toEqual({ status: "unavailable" });
    expect(await store.create(draft(0), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
  });
});

describe("note quota: recovery leaves alone what it should", () => {
  it("does not publish a pending record that is still young", async () => {
    await mkdir(join(slots, "0"), { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(join(slots, "0", RECORD_ID), recordFor(7));

    // The store is full of that record, and the record is not old enough to be anyone's to finish.
    expect(await open(1).create(draft(8), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toEqual([]);
    expect(await readdir(join(slots, "0"))).toEqual([RECORD_ID]);
  });

  it("gives a note made before slots one slot, however often the store is reconciled", async () => {
    await open(5).create(draft(0), live());
    await rm(slots, { recursive: true, force: true });
    await mkdir(slots, { recursive: true });

    const context = {
      files: nodeNoteFiles,
      notesDirectory: notes,
      slotDirectory: slots,
      maxNotes: 5,
      logger,
      now: () => clockBase + offsetMs,
    };

    for (let pass = 0; pass < 3; pass += 1) {
      await reconcileSlots(context, { next: 0 });
      expect(await slotNames()).toEqual(["0"]);
    }

    await expectEveryNoteBacked();
  });
});

describe("note quota: claims being prepared", () => {
  const PREPARED = ".claim-aaaaaaaa-1234-4234-8234-123456789abc";

  async function plantPrepared(): Promise<void> {
    await mkdir(join(slots, PREPARED), { recursive: true });
    await writeFile(join(slots, PREPARED, RECORD_ID), recordFor(0));
  }

  it("are not counted by the quota and are not published from, however old", async () => {
    await mkdir(notes, { recursive: true });
    await plantPrepared();
    offsetMs = TEMP_MAX_AGE_MS / 2;

    expect(await open(1).create(draft(1), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await noteFiles()).toEqual([`${noteIdFor(key(1))}.json`]);
  });

  it("are removed once old enough that no writer can still be preparing them", async () => {
    await mkdir(notes, { recursive: true });
    await plantPrepared();
    offsetMs = TEMP_MAX_AGE_MS * 2;

    await open(1).create(draft(1), live());

    expect(await readdir(slots)).not.toContain(PREPARED);
  });

  it("are kept while young", async () => {
    await mkdir(notes, { recursive: true });
    await plantPrepared();
    offsetMs = TEMP_MAX_AGE_MS / 2;

    await open(1).create(draft(1), live());

    expect(await readdir(slots)).toContain(PREPARED);
  });
});

describe("note quota: a note that is not a valid record", () => {
  it("has one slot however often the store is reconciled", async () => {
    await mkdir(notes, { recursive: true });
    await mkdir(slots, { recursive: true });
    await writeFile(join(notes, `${"a".repeat(32)}.json`), "not json at all");

    const context = {
      files: nodeNoteFiles,
      notesDirectory: notes,
      slotDirectory: slots,
      maxNotes: 10,
      logger,
      now: () => clockBase + offsetMs,
    };

    for (let pass = 0; pass < 4; pass += 1) {
      await reconcileSlots(context, { next: 0 });
    }

    expect(await slotNames()).toEqual(["0"]);
    await expectEveryNoteBacked();
  });
});

describe("note quota: notes made before slots existed", () => {
  it("accounts for old notes without changing them, and counts them against the limit", async () => {
    await plantLegacy(0);
    await plantLegacy(1);

    const before = await readFile(join(notes, `${noteIdFor(key(0))}.json`));
    const store = open(3);

    expect(await store.create(draft(2), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await store.create(draft(3), live())).toEqual({ status: "quota_exceeded" });
    expect(await readFile(join(notes, `${noteIdFor(key(0))}.json`))).toEqual(before);
    expect(await noteFiles()).toHaveLength(3);
    expect(await slotNames()).toHaveLength(3);
  });

  it("replays an old note without creating a second one", async () => {
    await plantLegacy(0);

    const outcome = await open(5).create(draft(0), live());

    expect(outcome).toEqual({ status: "exists", note: expect.objectContaining({ text: TEXT }) });
    expect(await noteFiles()).toHaveLength(1);
  });

  it("is not bypassed by old notes: a full store of old notes takes no new ones", async () => {
    for (let index = 0; index < 4; index += 1) {
      await plantLegacy(index);
    }

    const store = open(4);

    expect(await store.create(draft(10), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toHaveLength(4);
  });

  it("keeps old notes beyond a lowered limit, takes no new notes, and reports the rest", async () => {
    for (let index = 0; index < 5; index += 1) {
      await plantLegacy(index);
    }

    const store = open(2);

    expect(await store.create(draft(10), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toHaveLength(5);
    expect(await slotNames()).toHaveLength(2);
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "note_store.reconciled",
      fields: { published: 0, removed: 0, accounted: 2, unaccounted: 3, unreadable: 0 },
    });

    for (let index = 0; index < 5; index += 1) {
      expect(await store.read(noteIdFor(key(index)), live())).toEqual(
        expect.objectContaining({ status: "found" }),
      );
    }
  });

  it("is safe when two processes initialise the same old store at once", async () => {
    for (let index = 0; index < 5; index += 1) {
      await plantLegacy(index);
    }

    const first = open(10);
    const second = open(10);

    await Promise.all([first.create(draft(100), live()), second.create(draft(101), live())]);

    // Whatever duplicate slots the race left, five more notes fit and then the store is full.
    for (let index = 0; index < 3; index += 1) {
      expect(await first.create(draft(200 + index), live())).toEqual(
        expect.objectContaining({ status: "created" }),
      );
    }

    expect(await noteFiles()).toHaveLength(10);
    expect(await first.create(draft(999), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toHaveLength(10);
  });

  it("can be initialised again after an interrupted initialisation, with nothing duplicated", async () => {
    for (let index = 0; index < 3; index += 1) {
      await plantLegacy(index);
    }

    const interrupted = open(10, {
      ...nodeNoteFiles,
      createMarker: async () => {
        throw Object.assign(new Error("interrupted"), { code: "EIO" });
      },
    });

    expect(await interrupted.create(draft(50), live())).toEqual({ status: "unavailable" });
    expect(logger.entries.at(-1)?.fields).toEqual({
      operation: "create",
      phase: "init",
      errorCode: "EIO",
    });

    const store = open(10);

    expect(await store.create(draft(50), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await noteFiles()).toHaveLength(4);
    expect(await slotNames()).toHaveLength(4);
  });
});

describe("note quota: crashed writers", () => {
  /** A slot a crashed writer left: a complete record, no note. */
  async function plantPendingSlot(label: string | number, index: number): Promise<void> {
    await mkdir(join(slots, String(index)), { recursive: true });
    await writeFile(join(slots, String(index), RECORD_ID), recordFor(label));
  }

  it("publishes an old pending slot's note and keeps the slot that backs it, without taking a new slot", async () => {
    await mkdir(notes, { recursive: true });
    await plantPendingSlot(7, 0);
    offsetMs = ROLL_FORWARD_AFTER_MS * 2;

    const store = open(1);

    // The only slot is the pending one: the store is full, reconciles, publishes, and stays full.
    expect(await store.create(draft(8), live())).toEqual({ status: "quota_exceeded" });
    expect(await store.read(noteIdFor(key(7)), live())).toEqual(
      expect.objectContaining({ status: "found" }),
    );
    expect(await slotNames()).toEqual(["0"]);
    expect(await store.create(draft(7), live())).toEqual(
      expect.objectContaining({ status: "exists" }),
    );
  });

  it("leaves a young pending slot alone: it may belong to a writer that is still running", async () => {
    await mkdir(notes, { recursive: true });
    await plantPendingSlot(7, 0);

    const store = open(1);

    expect(await store.create(draft(8), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toEqual([]);
    expect(await slotNames()).toEqual(["0"]);
  });

  it("lets the retry of a crashed write commit it once, and frees the stale slot as surplus", async () => {
    await mkdir(notes, { recursive: true });
    await plantPendingSlot(7, 0);

    const store = open(2);

    expect(await store.create(draft(7), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await noteFiles()).toEqual([`${noteIdFor(key(7))}.json`]);

    // Slot 0 is stale and slot 1 backs the note: the next create finds the store full, reconciles,
    // drops the stale slot, and takes it.
    expect(await store.create(draft(8), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await slotNames()).toEqual(["0", "1"]);
    expect(await store.create(draft(9), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toHaveLength(2);
    await expectEveryNoteBacked();
  });

  it("never frees the slot that backs a note, however often it reconciles", async () => {
    const store = open(2);

    await store.create(draft(0), live());
    await store.create(draft(1), live());

    for (let round = 0; round < 3; round += 1) {
      offsetMs += 60_000;
      await store.create(draft(10 + round), live());
    }

    expect(await slotNames()).toEqual(["0", "1"]);
    expect(await noteFiles()).toHaveLength(2);
  });

  it("removes a duplicate slot of a published note and keeps the one that is the note", async () => {
    const store = open(3);

    await store.create(draft(0), live());
    await mkdir(join(slots, "1"));
    await copyFile(await recordOf(0), join(slots, "1", RECORD_ID));

    // Slots 0 (the note) and 1 (a copy, another file) exist, so a third note finds the store full,
    // reconciles, loses the copy, and takes its place; the slot that is the note stays.
    expect(await store.create(draft(1), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await slotNames()).toEqual(["0", "1", "2"]);
    expect(await store.create(draft(2), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await store.create(draft(3), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toHaveLength(3);
    await expectEveryNoteBacked();
  });

  it("publishes from the lowest of two pending slots for one note and frees the other in the same pass", async () => {
    await mkdir(notes, { recursive: true });
    await plantPendingSlot(7, 0);
    await plantPendingSlot(7, 1);
    offsetMs = ROLL_FORWARD_AFTER_MS * 2;

    const store = open(3);

    await store.create(draft(8), live());

    // Preparing the store reconciled it: one note published from slot 0, slot 1 freed, then the new
    // note took a slot: two notes, two slots, no surplus.
    expect(await noteFiles()).toHaveLength(2);
    expect(await slotNames()).toHaveLength(2);
    await expectEveryNoteBacked();
  });

  it("removes an empty slot directory, which only a release interrupted before its last step leaves", async () => {
    await mkdir(join(slots, "0"), { recursive: true });
    await mkdir(notes, { recursive: true });

    expect(await open(1).create(draft(0), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await slotNames()).toEqual(["0"]);
    await expectEveryNoteBacked();
  });

  it("never touches a slot that is not a valid record", async () => {
    await mkdir(join(slots, "0"), { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(join(slots, "0", RECORD_ID), "not a record");

    const store = open(1);

    expect(await store.create(draft(0), live())).toEqual({ status: "quota_exceeded" });
    expect(await readFile(join(slots, "0", RECORD_ID), "utf8")).toBe("not a record");
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ message: "note_store.reconciled" }),
    );
  });

  it("is idempotent: reconciling twice changes nothing the first did not", async () => {
    await mkdir(notes, { recursive: true });
    await plantPendingSlot(7, 0);
    await plantPendingSlot(7, 1);
    offsetMs = ROLL_FORWARD_AFTER_MS * 2;

    const store = open(2);

    await store.create(draft(8), live());

    const slotsAfterFirst = await slotNames();
    const notesAfterFirst = await noteFiles();

    offsetMs += 60_000;
    await store.create(draft(9), live());

    expect(await slotNames()).toEqual(slotsAfterFirst);
    expect(await noteFiles()).toEqual(notesAfterFirst);
  });

  it("publishes a pending slot's note once even when two processes race to roll it forward", async () => {
    await mkdir(notes, { recursive: true });
    await plantPendingSlot(7, 0);
    offsetMs = ROLL_FORWARD_AFTER_MS * 2;

    const first = open(1);
    const second = open(1);

    await Promise.all([first.create(draft(8), live()), second.create(draft(9), live())]);

    expect(await noteFiles()).toEqual([`${noteIdFor(key(7))}.json`]);
    expect(await slotNames()).toEqual(["0"]);
  });
});

describe("note quota: the write itself", () => {
  it("stops an abort before the slot is claimed and leaves nothing behind", async () => {
    const caller = new AbortController();

    const store = open(2, {
      ...nodeNoteFiles,
      writeSynced: async (path, data, signal) => {
        await nodeNoteFiles.writeSynced(path, data, signal);
        caller.abort();
      },
    });

    await expect(store.create(draft(0), caller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await noteFiles()).toEqual([]);
    expect(await slotNames()).toEqual([]);
  });

  it("finishes publishing once the slot is claimed, whatever the signal says", async () => {
    const caller = new AbortController();

    const store = open(2, {
      ...nodeNoteFiles,
      rename: async (from, to) => {
        await nodeNoteFiles.rename(from, to);
        caller.abort();
      },
    });

    expect(await store.create(draft(0), caller.signal)).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await noteFiles()).toHaveLength(1);
    expect(await slotNames()).toEqual(["0"]);
  });

  it("calls a note created when recovery published it from this write's own slot first", async () => {
    const store = open(2, {
      ...nodeNoteFiles,
      link: async (from, to) => {
        if (to.endsWith(".json")) {
          // Another process rolled the claimed slot forward, then this link fails.
          await nodeNoteFiles.link(await recordOf(0), to);
          throw Object.assign(new Error("exists"), { code: "EEXIST" });
        }

        return nodeNoteFiles.link(from, to);
      },
    });

    expect(await store.create(draft(0), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await slotNames()).toEqual(["0"]);
    expect(await noteFiles()).toHaveLength(1);
    await expectEveryNoteBacked();
  });

  /** The real recovery, run by another process whose clock is past the roll-forward age. */
  async function recover(): Promise<void> {
    await reconcileSlots(
      {
        files: nodeNoteFiles,
        notesDirectory: notes,
        slotDirectory: slots,
        maxNotes: 1,
        logger: createRecordingLogger(),
        now: () => clockBase + ROLL_FORWARD_AFTER_MS * 2,
      },
      { next: 0 },
    );
  }

  it.each(["EIO", "EEXIST"])(
    "keeps a published note backed when recovery publishes from the write's slot just as its link fails with %s",
    async (code) => {
      let rival: CreateNoteOutcome | undefined;
      let raced = false;

      const store = open(1, {
        ...nodeNoteFiles,
        link: async (from, to) => {
          if (to.endsWith(".json") && !raced) {
            raced = true;
            await recover();
            // A rival write arrives right then. Nothing that backs a note is ever released.
            rival = await open(1).create(draft(1), live());
            throw Object.assign(new Error("failed"), { code });
          }

          return nodeNoteFiles.link(from, to);
        },
      });

      expect(await store.create(draft(0), live())).toEqual(
        expect.objectContaining({ status: "created" }),
      );
      expect(rival).toEqual({ status: "quota_exceeded" });
      expect(await noteFiles()).toHaveLength(1);
      expect(await slotNames()).toEqual(["0"]);
      await expectEveryNoteBacked();
    },
  );

  it("keeps its slot and its record when the note cannot be published, and recovery publishes it later, once", async () => {
    let failed = false;

    const store = open(1, {
      ...nodeNoteFiles,
      link: async (from, to) => {
        if (to.endsWith(".json") && !failed) {
          failed = true;
          throw Object.assign(new Error("no"), { code: "EIO" });
        }

        return nodeNoteFiles.link(from, to);
      },
    });

    // The outcome is unknown to the caller: the record stays, and a later recovery may publish it.
    expect(await store.create(draft(0), live())).toEqual({ status: "unavailable" });
    expect(await noteFiles()).toEqual([]);
    expect(await slotNames()).toEqual(["0"]);
    expect(await readdir(join(slots, "0"))).toHaveLength(1);
    expect(logger.entries.at(-1)?.fields).toEqual({
      operation: "create",
      phase: "link",
      errorCode: "EIO",
    });

    offsetMs = ROLL_FORWARD_AFTER_MS * 2;

    expect(await open(1).create(draft(1), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toEqual([`${noteIdFor(key(0))}.json`]);
    expect(await slotNames()).toEqual(["0"]);
    await expectEveryNoteBacked();
    expect(await open(1).create(draft(0), live())).toEqual(
      expect.objectContaining({ status: "exists" }),
    );
  });

  it("finishes a recovery that was interrupted before it published", async () => {
    await mkdir(join(slots, "0"), { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(join(slots, "0", RECORD_ID), recordFor(0));
    offsetMs = ROLL_FORWARD_AFTER_MS * 2;

    const interrupted = open(1, {
      ...nodeNoteFiles,
      link: async (from, to) => {
        if (to.endsWith(".json")) {
          throw Object.assign(new Error("interrupted"), { code: "EIO" });
        }

        return nodeNoteFiles.link(from, to);
      },
    });

    expect(await interrupted.create(draft(1), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toEqual([]);
    expect(await readdir(join(slots, "0"))).toEqual([RECORD_ID]);

    // The next one starts from the same record and publishes from it.
    await unlink(join(slots, ".ready"));
    expect(await open(1).create(draft(1), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteFiles()).toEqual([`${noteIdFor(key(0))}.json`]);
    expect(await slotNames()).toEqual(["0"]);
    await expectEveryNoteBacked();
  });

  it("claims slots with the record complete, so a slot is never empty", async () => {
    let seen = "";

    const store = open(2, {
      ...nodeNoteFiles,
      link: async (from, to) => {
        if (to.startsWith(slots)) {
          seen = await readFile(from, "utf8");
        }

        return nodeNoteFiles.link(from, to);
      },
    });

    await store.create(draft(0), live());

    expect(JSON.parse(seen)).toEqual(JSON.parse(recordFor(0)));
  });
});

describe("note quota: recovery that cannot finish", () => {
  async function plantOldPending(label: number): Promise<void> {
    await mkdir(join(slots, "0"), { recursive: true });
    await mkdir(notes, { recursive: true });
    await writeFile(join(slots, "0", RECORD_ID), recordFor(label));
    offsetMs = ROLL_FORWARD_AFTER_MS * 2;
  }

  it("logs a publication that failed for a system reason, and leaves the slot for next time", async () => {
    await plantOldPending(7);

    const store = open(1, {
      ...nodeNoteFiles,
      link: async (from, to) => {
        if (to.endsWith(".json")) {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        }

        return nodeNoteFiles.link(from, to);
      },
    });

    expect(await store.create(draft(8), live())).toEqual({ status: "quota_exceeded" });
    expect(logger.entries).toContainEqual({
      level: "warn",
      message: "note_store.unavailable",
      fields: { operation: "reconcile", phase: "link", errorCode: "EPERM" },
    });
    expect(await noteFiles()).toEqual([]);
    expect(await slotNames()).toEqual(["0"]);
    expectSafeLogs();
  });

  it("says nothing when the record it meant to publish was removed meanwhile", async () => {
    await plantOldPending(7);

    const store = open(1, {
      ...nodeNoteFiles,
      link: async (from, to) => {
        if (to.endsWith(".json")) {
          throw Object.assign(new Error("gone"), { code: "ENOENT" });
        }

        return nodeNoteFiles.link(from, to);
      },
    });

    expect(await store.create(draft(8), live())).toEqual({ status: "quota_exceeded" });
    expect(logger.entries.filter((entry) => entry.message === "note_store.unavailable")).toEqual(
      [],
    );
  });
});

describe("note quota: when the filesystem cannot answer a question", () => {
  it("treats an existence probe that fails as no answer, and still stores and replays notes", async () => {
    const store = open(5, {
      ...nodeNoteFiles,
      identityOf: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    });

    // Preparation needs identityOf, so prepare the store first with the real filesystem.
    await open(5).create(draft(0), live());

    expect(await store.create(draft(0), live())).toEqual({ status: "unavailable" });
  });
});

describe("note quota: temp files", () => {
  const OLD = ".tmp-12345678-1234-1234-1234-123456789abc";
  const OTHER = ".tmp-aaaaaaaa-1234-1234-1234-123456789abc";

  async function plantTemp(name: string): Promise<void> {
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, name), recordFor(0));
  }

  it("removes temp files old enough that no writer can still be using them, and only those", async () => {
    await plantTemp(OLD);
    offsetMs = TEMP_MAX_AGE_MS * 2;
    await plantTemp(OTHER);
    // Planted now but read as old by the store's clock: the other is the same age here, so move time.
    offsetMs = 0;

    const store = open(5);

    await store.create(draft(0), live());
    expect(await readdir(notes)).toEqual(expect.arrayContaining([OLD, OTHER]));

    offsetMs = TEMP_MAX_AGE_MS * 2;

    const later = open(5);

    await later.create(draft(1), live());
    expect((await readdir(notes)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "note_store.temp_swept",
      fields: { removed: 2 },
    });
  });

  it("keeps temp files that are not yet old", async () => {
    await plantTemp(OLD);
    offsetMs = TEMP_MAX_AGE_MS / 2;

    await open(5).create(draft(0), live());

    expect(await readdir(notes)).toContain(OLD);
  });

  it("never removes anything that is not a temp file of this store", async () => {
    await mkdir(notes, { recursive: true });
    await writeFile(join(notes, "keep.txt"), "mine");
    await writeFile(join(notes, ".tmp-not-a-uuid"), "mine");
    await writeFile(join(notes, ".tmp-12345678-1234-1234-1234-123456789abc.extra"), "mine");
    await mkdir(join(notes, OLD));
    offsetMs = TEMP_MAX_AGE_MS * 10;

    await open(5).create(draft(0), live());

    const names = await readdir(notes);

    // Nothing even tried to remove them.
    expect(logger.entries.filter((entry) => entry.level === "warn")).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining([
        "keep.txt",
        ".tmp-not-a-uuid",
        ".tmp-12345678-1234-1234-1234-123456789abc.extra",
        OLD,
      ]),
    );
  });

  it("never touches a note file, however old", async () => {
    await plantLegacy(0);
    offsetMs = TEMP_MAX_AGE_MS * 10;

    await open(5).create(draft(1), live());

    expect(await noteFiles()).toContain(`${noteIdFor(key(0))}.json`);
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a link named like a temp file",
    async () => {
      const outside = join(root, "outside.txt");

      await writeFile(outside, "must survive");
      await mkdir(notes, { recursive: true });
      await symlink(outside, join(notes, OLD));
      offsetMs = TEMP_MAX_AGE_MS * 10;

      await open(5).create(draft(0), live());

      expect(await readFile(outside, "utf8")).toBe("must survive");
      expect(await readdir(notes)).toContain(OLD);
    },
  );

  it("is safe when two stores sweep at once, and when repeated", async () => {
    await plantTemp(OLD);
    offsetMs = TEMP_MAX_AGE_MS * 2;

    await Promise.all([open(5).create(draft(0), live()), open(5).create(draft(1), live())]);
    await open(5).create(draft(2), live());

    expect((await readdir(notes)).filter((name) => name.startsWith(".tmp-"))).toEqual([]);
    expect(await noteFiles()).toHaveLength(3);
  });

  it("does not turn an old temp file's disappearance during a write into a lost note", async () => {
    const store = open(5, {
      ...nodeNoteFiles,
      writeSynced: async (path, data, signal) => {
        await nodeNoteFiles.writeSynced(path, data, signal);
        // A sweeper judged this live write's file old and removed it before the slot was claimed.
        await nodeNoteFiles.remove(path);
      },
    });

    expect(await store.create(draft(0), live())).toEqual({ status: "unavailable" });
    expect(await noteFiles()).toEqual([]);
    expect(await slotNames()).toEqual([]);
    expect(await open(5).create(draft(0), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
  });
});

describe("note quota: the filesystem", () => {
  it("makes hard links share one identity, and distinct files differ", async () => {
    await mkdir(root, { recursive: true });

    const a = join(root, "a");
    const b = join(root, "b");
    const c = join(root, "c");

    await writeFile(a, "x");
    await writeFile(c, "x");
    await nodeNoteFiles.link(a, b);

    const [identityA, identityB, identityC] = await Promise.all([
      nodeNoteFiles.identityOf(a),
      nodeNoteFiles.identityOf(b),
      nodeNoteFiles.identityOf(c),
    ]);

    expect(identityA).toBeDefined();
    expect(identityA?.ino).toBe(identityB?.ino);
    expect(identityA?.dev).toBe(identityB?.dev);
    expect(identityA?.ino).not.toBe(identityC?.ino);
    expect(await nodeNoteFiles.identityOf(join(root, "missing"))).toBeUndefined();
  });

  it("refuses a slot directory that is a file, without writing anywhere", async () => {
    await writeFile(slots, "in the way");

    expect(await open(5).create(draft(0), live())).toEqual({ status: "unavailable" });
    expect(logger.entries.at(-1)?.fields).toEqual(
      expect.objectContaining({ operation: "create", phase: "mkdir" }),
    );
    expect(await readFile(slots, "utf8")).toBe("in the way");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a slot directory that is a link, so slots cannot be pointed elsewhere",
    async () => {
      const elsewhere = join(root, "elsewhere");

      await mkdir(elsewhere);
      await symlink(elsewhere, slots);

      expect(await open(5).create(draft(0), live())).toEqual({ status: "unavailable" });
      expect(logger.entries.at(-1)?.fields).toEqual({
        operation: "create",
        phase: "init",
        errorCode: "EINVAL",
      });
      expect(await readdir(elsewhere)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a link at a note's name, and a FIFO there cannot hang a read",
    async () => {
      const outside = join(root, "outside.json");
      const id = noteIdFor(key(0));

      await mkdir(notes, { recursive: true });
      await writeFile(outside, recordFor(0));
      await symlink(outside, join(notes, `${id}.json`));

      const store = open(5);

      expect(await store.read(id, live())).toEqual({ status: "unavailable" });
      expect(await store.create(draft(0), live())).toEqual({ status: "unavailable" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "reads a FIFO at a note's name as unavailable at once",
    async () => {
      const { execFileSync } = await import("node:child_process");
      const id = noteIdFor(key(1));

      await mkdir(notes, { recursive: true });
      execFileSync("mkfifo", [join(notes, `${id}.json`)]);

      expect(await open(5).read(id, live())).toEqual({ status: "unavailable" });
    },
  );

  it("keeps logs free of paths, keys and note text through a whole quota and recovery cycle", async () => {
    await plantLegacy(0);

    const store = open(2);

    await store.create(draft(1), live());
    await store.create(draft(2), live());
    await store.create(draft(3), live());
    offsetMs = TEMP_MAX_AGE_MS * 10;
    await open(2).create(draft(4), live());

    expect(logger.entries.length).toBeGreaterThan(0);
    expectSafeLogs();
  });

  it.skipIf(process.platform === "win32")(
    "creates the slot directory owner-only and its files owner-read/write",
    async () => {
      const { stat } = await import("node:fs/promises");

      await open(2).create(draft(0), live());

      expect((await stat(slots)).mode & 0o777).toBe(0o700);
      expect((await stat(join(slots, "0"))).mode & 0o777).toBe(0o700);
      expect((await stat(await recordOf(0))).mode & 0o777).toBe(0o600);
    },
  );
});
