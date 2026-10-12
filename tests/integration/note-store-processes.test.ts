import { type ChildProcess, spawn } from "node:child_process";
import { lstat, mkdtemp, readdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFileNoteStore } from "../../src/adapters/persistence/file-note-store.js";
import { noteIdFor } from "../../src/adapters/persistence/note-record.js";
import {
  ROLL_FORWARD_AFTER_MS,
  TEMP_MAX_AGE_MS,
} from "../../src/adapters/persistence/note-slot-layout.js";
import type { NoteStore } from "../../src/ports/note-store.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";

/**
 * Real processes sharing one store directory: how many notes they leave behind, and what a store
 * does after a process is killed at each step of a create. Nothing here waits on a timer for
 * correctness: processes report when they reach a step, and time is the stores' injected clock.
 */
vi.setConfig({ testTimeout: 120_000 });

const SRC = pathToFileURL(join(import.meta.dirname, "..", "..", "src")).href;

/** What each child process runs, under tsx so it loads the TypeScript sources. */
const WORKER = `
const { createFileNoteStore, nodeNoteFiles } = await import(process.env.SRC + "/adapters/persistence/file-note-store.ts");
const key = (label) => "proc-key-" + String(label).padStart(8, "0");
const dir = process.env.NOTES;
const max = Number(process.env.MAX);
const mode = process.env.MODE;
const hang = () => new Promise(() => {});
const files = { ...nodeNoteFiles };
if (mode === "before-claim") files.claimDirectory = async (path) => { process.send({ type: "reached" }); await hang(); };
if (mode === "after-mkdir") files.claimDirectory = async (path) => { await nodeNoteFiles.claimDirectory(path); process.send({ type: "reached" }); await hang(); };
if (mode === "after-prepare") files.link = async (from, to) => { await nodeNoteFiles.link(from, to); if (to.includes(".claim-")) { process.send({ type: "reached" }); await hang(); } };
if (mode === "after-claim") files.rename = async (from, to) => { await nodeNoteFiles.rename(from, to); process.send({ type: "reached" }); await hang(); };
if (mode === "after-publish") files.link = async (from, to) => { await nodeNoteFiles.link(from, to); if (to.endsWith(".json")) { process.send({ type: "reached" }); await hang(); } };
const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
const store = createFileNoteStore({ directory: dir, maxNotes: max, logger, files, now: () => Date.now() + Number(process.env.OFFSET ?? 0) });
const signal = new AbortController().signal;
const labels = JSON.parse(process.env.LABELS);
const text = process.env.TEXT ?? "note";
const results = await Promise.all(labels.map((label) => store.create({ idempotencyKey: key(label), text, createdAt: new Date() }, signal)));
const counts = {};
for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log(JSON.stringify(counts));
`;

const countsSchema = z.record(z.string(), z.number());

function key(label: string | number): string {
  return `proc-key-${String(label).padStart(8, "0")}`;
}

let root: string;

let notes: string;

let slots: string;

const children: ChildProcess[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "note-store-procs-"));
  notes = join(root, "notes");
  slots = `${notes}.slots`;
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }

  await rm(root, { recursive: true, force: true });
});

interface Worker {
  readonly child: ChildProcess;
  readonly exited: Promise<{ code: number | null }>;
  readonly stdout: () => string;
  readonly reached: Promise<void>;
}

function startWorker(settings: {
  readonly max: number;
  readonly labels: readonly (string | number)[];
  readonly mode?: string;
  readonly text?: string;
  readonly offsetMs?: number;
}): Worker {
  const env = {
    ...getDefaultEnvironment(),
    SRC,
    NOTES: notes,
    MAX: String(settings.max),
    LABELS: JSON.stringify(settings.labels),
    MODE: settings.mode ?? "none",
    TEXT: settings.text ?? "note",
    OFFSET: String(settings.offsetMs ?? 0),
  };

  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", WORKER], {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  children.push(child);

  let out = "";
  let err = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });

  const reached = new Promise<void>((resolve) => {
    child.on("message", () => resolve());
  });

  const exited = new Promise<{ code: number | null }>((resolve) => {
    child.on("exit", (code) => {
      if (code !== 0 && code !== null && err !== "") {
        process.stderr.write(err);
      }

      resolve({ code });
    });
  });

  return { child, exited, stdout: () => out, reached };
}

async function finished(worker: Worker): Promise<Record<string, number>> {
  expect((await worker.exited).code).toBe(0);

  return countsSchema.parse(JSON.parse(worker.stdout().trim()));
}

function total(results: readonly Record<string, number>[], status: string): number {
  return results.reduce((sum, counts) => sum + (counts[status] ?? 0), 0);
}

async function noteCount(): Promise<number> {
  return (await readdir(notes)).filter((name) => name.endsWith(".json")).length;
}

async function slotCount(): Promise<number> {
  const entries = await readdir(slots, { withFileTypes: true });

  return entries.filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name)).length;
}

/** A store over the same directories, with a clock the test moves. */
function parentStore(maxNotes: number, offsetMs = 0): NoteStore {
  return createFileNoteStore({
    directory: notes,
    maxNotes,
    logger: createRecordingLogger(),
    now: () => Date.now() + offsetMs,
  });
}

/** Every note is the same file as some slot record: that is what backs it against the quota. */
async function expectEveryNoteBacked(): Promise<void> {
  const backing = new Set<string>();

  for (const slot of await readdir(slots, { withFileTypes: true })) {
    if (!slot.isDirectory()) {
      continue;
    }

    for (const record of await readdir(join(slots, slot.name))) {
      const stats = await lstat(join(slots, slot.name, record), { bigint: true });

      backing.add(`${stats.dev}:${stats.ino}`);
    }
  }

  for (const name of (await readdir(notes)).filter((entry) => entry.endsWith(".json"))) {
    const stats = await lstat(join(notes, name), { bigint: true });

    expect(backing.has(`${stats.dev}:${stats.ino}`)).toBe(true);
  }
}

function live(): AbortSignal {
  return new AbortController().signal;
}

function draft(label: string | number) {
  return { idempotencyKey: key(label), text: "parent", createdAt: new Date() };
}

describe("note store across processes", () => {
  it("never holds more than the quota when several processes create different notes at once", async () => {
    const workers = [0, 1, 2, 3].map((worker) =>
      startWorker({
        max: 50,
        labels: Array.from({ length: 40 }, (_, index) => worker * 1_000 + index),
      }),
    );

    const results = await Promise.all(workers.map(finished));

    expect(total(results, "created")).toBe(50);
    expect(total(results, "quota_exceeded")).toBe(110);
    expect(await noteCount()).toBe(50);
    expect(await slotCount()).toBe(50);
    await expectEveryNoteBacked();
  });

  it("never exceeds the quota when several processes race over the same keys, and leaks no slot", async () => {
    const labels = Array.from({ length: 20 }, (_, index) => index);
    const workers = [0, 1, 2, 3].map(() => startWorker({ max: 10, labels }));
    const results = await Promise.all(workers.map(finished));

    // Racing creators of one key briefly hold a slot each, so near the quota some are refused while
    // the store is "full" of losers' slots: fewer than ten may have been created, never more.
    const created = total(results, "created");

    expect(created).toBeLessThanOrEqual(10);
    expect(await noteCount()).toBe(created);
    expect(await slotCount()).toBe(created);
    await expectEveryNoteBacked();

    // Nothing was lost: once the race is over the store still fills to exactly its quota.
    const store = parentStore(10);

    for (const label of labels) {
      await store.create(draft(label), live());
    }

    expect(await noteCount()).toBe(10);
    expect(await slotCount()).toBe(10);
  });

  it("commits one note when every process creates the same key with its own text", async () => {
    const workers = [0, 1, 2, 3].map((worker) =>
      startWorker({ max: 10, labels: ["same"], text: `text from ${worker}` }),
    );

    const results = await Promise.all(workers.map(finished));

    expect(total(results, "created")).toBe(1);
    expect(total(results, "exists")).toBe(3);
    expect(await noteCount()).toBe(1);
    expect(await slotCount()).toBe(1);
    await expectEveryNoteBacked();
  });

  it("keeps replays working at the quota, from another process", async () => {
    const first = startWorker({ max: 5, labels: [0, 1, 2, 3, 4] });

    expect(await finished(first)).toEqual({ created: 5 });

    const second = startWorker({ max: 5, labels: [0, 1, 2, 3, 4, 5, 6] });

    expect(await finished(second)).toEqual({ exists: 5, quota_exceeded: 2 });
    expect(await noteCount()).toBe(5);
  });
});

describe("note store after a process is killed", () => {
  async function killAt(mode: string, label: string | number): Promise<void> {
    const worker = startWorker({ max: 5, labels: [label], mode });

    await worker.reached;
    worker.child.kill("SIGKILL");
    await worker.exited;
  }

  it("before the slot is claimed: no note, no slot, and the retry creates it", async () => {
    await killAt("before-claim", "a");

    expect(await noteCount()).toBe(0);
    expect(await slotCount()).toBe(0);

    const store = parentStore(5);

    expect(await store.create(draft("a"), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );
    expect(await noteCount()).toBe(1);
    expect(await slotCount()).toBe(1);
  });

  const preparing = () =>
    readdir(slots).then((names) => names.filter((name) => name.startsWith(".claim-")));

  it.each(["after-mkdir", "after-prepare"])(
    "%s: a claim being prepared takes no slot and publishes nothing, and is removed once old",
    async (mode) => {
      await killAt(mode, "a");

      expect(await noteCount()).toBe(0);
      expect(await slotCount()).toBe(0);
      expect(await preparing()).toHaveLength(1);

      // It does not count against the quota, and a retry is unaffected.
      expect(await parentStore(1).create(draft("a"), live())).toEqual(
        expect.objectContaining({ status: "created" }),
      );
      expect(await slotCount()).toBe(1);
      expect(await preparing()).toHaveLength(1);

      await parentStore(1, TEMP_MAX_AGE_MS * 2).create(draft("a"), live());
      expect(await preparing()).toEqual([]);
      expect(await noteCount()).toBe(1);
      expect(await slotCount()).toBe(1);
    },
  );

  it("leaves a temp file when killed before the claim, which a later store removes once it is old", async () => {
    await killAt("before-claim", "a");

    const leftovers = () =>
      readdir(notes).then((names) => names.filter((n) => n.startsWith(".tmp-")));

    expect(await leftovers()).toHaveLength(1);

    await parentStore(5).create(draft("b"), live());
    expect(await leftovers()).toHaveLength(1);

    await parentStore(5, TEMP_MAX_AGE_MS * 2).create(draft("c"), live());
    expect(await leftovers()).toEqual([]);
  });

  it("after the slot is claimed, before the note: the retry commits it once and the quota holds", async () => {
    await killAt("after-claim", "a");

    expect(await noteCount()).toBe(0);
    expect(await slotCount()).toBe(1);

    const store = parentStore(5);

    expect(await store.read(noteIdFor(key("a")), live())).toEqual({ status: "not_found" });
    expect(await store.create(draft("a"), live())).toEqual(
      expect.objectContaining({ status: "created" }),
    );

    // Fill to the quota: the stale slot is reclaimed when the store is found full.
    for (const label of ["b", "c", "d", "e"]) {
      expect(await store.create(draft(label), live())).toEqual(
        expect.objectContaining({ status: "created" }),
      );
    }

    expect(await store.create(draft("f"), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteCount()).toBe(5);
    expect(await slotCount()).toBe(5);
  });

  it("after the slot is claimed, with no retry: the note is published from the slot once it is old", async () => {
    await killAt("after-claim", "a");

    const store = parentStore(1, ROLL_FORWARD_AFTER_MS * 2);

    expect(await store.create(draft("other"), live())).toEqual({ status: "quota_exceeded" });
    expect(await store.read(noteIdFor(key("a")), live())).toEqual(
      expect.objectContaining({ status: "found" }),
    );
    expect(await noteCount()).toBe(1);
    expect(await slotCount()).toBe(1);
  });

  it("immediately after the note is committed: it is there, the retry is a replay, one slot", async () => {
    await killAt("after-publish", "a");

    expect(await noteCount()).toBe(1);

    const store = parentStore(5);

    expect(await store.read(noteIdFor(key("a")), live())).toEqual(
      expect.objectContaining({ status: "found" }),
    );
    expect(await store.create(draft("a"), live())).toEqual(
      expect.objectContaining({ status: "exists" }),
    );
    expect(await noteCount()).toBe(1);
    expect(await slotCount()).toBe(1);
  });

  it("never exceeds the quota however many writers were killed in the middle", async () => {
    for (const label of ["a", "b", "c"]) {
      await killAt("after-claim", label);
    }

    const store = parentStore(3, ROLL_FORWARD_AFTER_MS * 2);

    expect(await store.create(draft("d"), live())).toEqual({ status: "quota_exceeded" });
    expect(await noteCount()).toBe(3);
    expect(await slotCount()).toBe(3);
  });

  it("repeated crashes of one key leave stale slots, never a second note, and recovery frees them", async () => {
    for (let crash = 0; crash < 3; crash += 1) {
      await killAt("after-claim", "same");
    }

    // The retry finds no note (nothing was published), so it publishes its own, and is the only note.
    expect(await finished(startWorker({ max: 5, labels: ["same"] }))).toEqual({ created: 1 });
    expect(await noteCount()).toBe(1);
    expect(await slotCount()).toBeLessThanOrEqual(4);

    // A reconcile (forced by removing the ready marker) frees every slot that is not the note's.
    await unlink(join(slots, ".ready"));
    await parentStore(5, ROLL_FORWARD_AFTER_MS * 2).create(draft("other"), live());

    expect(await noteCount()).toBe(2);
    expect(await slotCount()).toBe(2);
    await expectEveryNoteBacked();
  });

  it("recovers abandoned slots in several processes at once, publishing each note once", async () => {
    for (const label of ["a", "b", "c", "d"]) {
      await killAt("after-claim", label);
    }

    expect(await noteCount()).toBe(0);
    await unlink(join(slots, ".ready"));

    const workers = [0, 1, 2, 3].map((worker) =>
      startWorker({ max: 8, labels: [`new-${worker}`], offsetMs: ROLL_FORWARD_AFTER_MS * 2 }),
    );

    const results = await Promise.all(workers.map(finished));

    expect(total(results, "created")).toBe(4);
    expect(await noteCount()).toBe(8);
    expect(await slotCount()).toBe(8);
    await expectEveryNoteBacked();

    for (const label of ["a", "b", "c", "d"]) {
      expect(await parentStore(8).create(draft(label), live())).toEqual(
        expect.objectContaining({ status: "exists" }),
      );
    }
  });
});
