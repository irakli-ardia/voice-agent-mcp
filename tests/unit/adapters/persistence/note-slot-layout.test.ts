import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type NoteFiles, nodeNoteFiles } from "../../../../src/adapters/persistence/note-files.js";
import {
  claimFrom,
  freeSlot,
  type SlotContext,
  type SlotCursor,
} from "../../../../src/adapters/persistence/note-slot-layout.js";
import { createRecordingLogger } from "../../../helpers/recording-logger.js";

let root: string;

let source: string;

let slots: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "slot-layout-"));
  slots = join(root, "slots");
  source = join(root, "record");
  await mkdir(slots);
  await writeFile(source, "complete record");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function context(maxNotes: number, files: NoteFiles = nodeNoteFiles): SlotContext {
  return {
    files,
    notesDirectory: join(root, "notes"),
    slotDirectory: slots,
    maxNotes,
    logger: createRecordingLogger(),
    now: () => Date.now(),
  };
}

function cursor(): SlotCursor {
  return { next: 0 };
}

async function recordsIn(index: number): Promise<string[]> {
  return readdir(join(slots, String(index))).catch(() => []);
}

describe("removals that go wrong", () => {
  const busy = () => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" }));

  it("logs a record that cannot be removed, with the error code only", async () => {
    const logger = createRecordingLogger();
    const files: NoteFiles = { ...nodeNoteFiles, remove: busy };
    const claim = await claimFrom({ ...context(2), logger }, cursor(), source);

    if (claim === undefined) {
      throw new Error("expected a claim");
    }

    await freeSlot({ ...context(2, files), logger }, claim);

    expect(logger.entries).toEqual([
      { level: "warn", message: "note_store.temp_cleanup_failed", fields: { errorCode: "EBUSY" } },
    ]);
  });

  it("logs a slot directory that cannot be removed for a reason other than being in use", async () => {
    const logger = createRecordingLogger();
    const files: NoteFiles = { ...nodeNoteFiles, removeDirectory: busy };
    const claim = await claimFrom({ ...context(2), logger }, cursor(), source);

    if (claim === undefined) {
      throw new Error("expected a claim");
    }

    await freeSlot({ ...context(2, files), logger }, claim);

    expect(logger.entries).toEqual([
      { level: "warn", message: "note_store.temp_cleanup_failed", fields: { errorCode: "EBUSY" } },
    ]);
  });
});

describe("the filesystem seam", () => {
  it("lists a missing directory as empty", async () => {
    expect(await nodeNoteFiles.listDirectory(join(root, "missing"))).toEqual([]);
  });
});

describe("a claim becomes visible whole", () => {
  it("is renamed into place with its record already in it, so no slot is ever empty or half made", async () => {
    const seen: string[][] = [];

    const files: NoteFiles = {
      ...nodeNoteFiles,
      rename: async (from, to) => {
        // Just before it becomes a slot: the claim is outside the slots, and already complete.
        seen.push(await readdir(from), await readdir(slots));

        return nodeNoteFiles.rename(from, to);
      },
    };

    const claim = await claimFrom(context(1, files), cursor(), source);

    expect(seen[0]).toEqual([claim?.record]);
    expect(seen[1]?.some((name) => /^\d+$/.test(name))).toBe(false);
    expect(await readdir(slots)).toEqual(["0"]);
  });

  it("goes to exactly one of several claimers racing for the only slot", async () => {
    const sources = await Promise.all(
      [0, 1, 2, 3, 4, 5].map(async (index) => {
        const path = join(root, `record-${index}`);

        await writeFile(path, `record ${index}`);

        return path;
      }),
    );

    const claims = await Promise.all(
      sources.map(async (path) => claimFrom(context(1), cursor(), path)),
    );

    expect(claims.filter((claim) => claim !== undefined)).toHaveLength(1);
    expect(await readdir(slots)).toEqual(["0"]);
    expect(await recordsIn(0)).toHaveLength(1);
  });

  it("is not removed by a stale release whose record is already gone", async () => {
    const stale = await claimFrom(context(1), cursor(), source);

    if (stale === undefined) {
      throw new Error("expected a claim");
    }

    await freeSlot(context(1), stale);

    const newer = await claimFrom(context(1), cursor(), source);

    expect(await freeSlot(context(1), stale)).toBe(false);
    expect(await recordsIn(0)).toEqual([newer?.record]);
  });

  it("leaves nothing behind when the store is full", async () => {
    await claimFrom(context(1), cursor(), source);

    expect(await claimFrom(context(1), cursor(), source)).toBeUndefined();
    expect(await readdir(slots)).toEqual(["0"]);
  });

  it("fails, leaving nothing behind, when the claim in preparation is swept away", async () => {
    const files: NoteFiles = {
      ...nodeNoteFiles,
      rename: async (from) => {
        await rm(from, { recursive: true });

        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    };

    await expect(claimFrom(context(1, files), cursor(), source)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readdir(slots)).toEqual([]);
  });

  it("does not call the store full when a rename was refused and no slot is to be seen", async () => {
    const files: NoteFiles = {
      ...nodeNoteFiles,
      rename: () => Promise.reject(Object.assign(new Error("denied"), { code: "EPERM" })),
    };

    await expect(claimFrom(context(2, files), cursor(), source)).rejects.toMatchObject({
      code: "EBUSY",
    });
    expect(await readdir(slots)).toEqual([]);
  });

  it("counts a slot it still cannot judge as taken when other slots were judged taken", async () => {
    await mkdir(join(slots, "0"));
    await writeFile(join(slots, "0", "00000000-0000-4000-8000-000000000000"), "taken");

    const files: NoteFiles = {
      ...nodeNoteFiles,
      rename: async (from, to) => {
        if (to.endsWith("1")) {
          throw Object.assign(new Error("in flight"), { code: "EPERM" });
        }

        return nodeNoteFiles.rename(from, to);
      },
    };

    expect(await claimFrom(context(2, files), cursor(), source)).toBeUndefined();
    expect(await readdir(slots)).toEqual(["0"]);
  });

  it("looks again at a slot it could not judge, and takes it when it turns out free", async () => {
    let refused = false;

    const files: NoteFiles = {
      ...nodeNoteFiles,
      rename: async (from, to) => {
        if (!refused) {
          refused = true;
          throw Object.assign(new Error("in flight"), { code: "EPERM" });
        }

        return nodeNoteFiles.rename(from, to);
      },
    };

    expect((await claimFrom(context(1, files), cursor(), source))?.index).toBe(0);
    expect(await recordsIn(0)).toHaveLength(1);
  });

  it("throws any other failure to rename as it is", async () => {
    const files: NoteFiles = {
      ...nodeNoteFiles,
      rename: () => Promise.reject(Object.assign(new Error("io"), { code: "EIO" })),
    };

    await expect(claimFrom(context(2, files), cursor(), source)).rejects.toMatchObject({
      code: "EIO",
    });
    expect(await readdir(slots)).toEqual([]);
  });
});

describe("removals that find a newer claim", () => {
  it("say nothing when the directory is no longer empty", async () => {
    const logger = createRecordingLogger();

    const files: NoteFiles = {
      ...nodeNoteFiles,
      removeDirectory: () =>
        Promise.reject(Object.assign(new Error("not empty"), { code: "ENOTEMPTY" })),
    };

    const claim = await claimFrom(context(1), cursor(), source);

    if (claim === undefined) {
      throw new Error("expected a claim");
    }

    expect(await freeSlot({ ...context(1, files), logger }, claim)).toBe(true);
    expect(logger.entries).toEqual([]);
  });
});

describe("slot claims", () => {
  it("claims the first free slot, as a directory holding the record under a unique name", async () => {
    const claim = await claimFrom(context(3), cursor(), source);

    expect(claim).toEqual({ index: 0, record: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    expect(await recordsIn(0)).toEqual([claim?.record]);
  });

  it("moves the cursor past the slot it claimed, so the next claim starts at a free one", async () => {
    const shared = cursor();

    await claimFrom(context(5), shared, source);

    expect(shared.next).toBe(1);

    await claimFrom(context(5), shared, source);

    expect(shared.next).toBe(2);
  });

  it("wraps the cursor around the end of the slots", async () => {
    const shared = { next: 2 };

    expect((await claimFrom(context(3), shared, source))?.index).toBe(2);
    expect(shared.next).toBe(0);
  });

  it("claims each slot once and then reports none free", async () => {
    const shared = cursor();
    const claims = [];

    for (let index = 0; index < 4; index += 1) {
      claims.push(await claimFrom(context(3), shared, source));
    }

    expect(claims.map((claim) => claim?.index)).toEqual([0, 1, 2, undefined]);
  });

  it("follows a fixed order for a whole pass even when a concurrent claim moves the cursor", async () => {
    const moving = cursor();

    const files: NoteFiles = {
      ...nodeNoteFiles,
      rename: async (from, to) => {
        // Another claim succeeds while this pass runs, and the cursor jumps ahead.
        moving.next = (moving.next + 1) % 4;

        return nodeNoteFiles.rename(from, to);
      },
    };

    // Slots 0..2 are taken; a pass that followed the cursor could skip slot 3.
    for (let index = 0; index < 3; index += 1) {
      await mkdir(join(slots, String(index)));
      await writeFile(join(slots, String(index), "00000000-0000-4000-8000-000000000000"), "taken");
    }

    expect((await claimFrom(context(4, files), moving, source))?.index).toBe(3);
  });

  it("does not delete a newer claim of the same index when a stale release arrives late", async () => {
    const stale = await claimFrom(context(1), cursor(), source);

    if (stale === undefined) {
      throw new Error("expected a claim");
    }

    await freeSlot(context(1), stale);

    const newer = await claimFrom(context(1), cursor(), source);

    expect(newer?.index).toBe(0);

    // The first writer's release runs again, long after its slot was freed and claimed anew.
    await freeSlot(context(1), stale);

    expect(await recordsIn(0)).toEqual([newer?.record]);
  });

  it("treats a stale release as nothing, not as a failure worth logging", async () => {
    const logger = createRecordingLogger();
    const withLogger = { ...context(1), logger };
    const stale = await claimFrom(withLogger, cursor(), source);

    if (stale === undefined) {
      throw new Error("expected a claim");
    }

    await freeSlot(withLogger, stale);
    await claimFrom(withLogger, cursor(), source);
    await freeSlot(withLogger, stale);

    expect(logger.entries).toEqual([]);
  });

  it("frees a slot completely: the record and then the directory", async () => {
    const claim = await claimFrom(context(2), cursor(), source);

    if (claim === undefined) {
      throw new Error("expected a claim");
    }

    await freeSlot(context(2), claim);

    expect(await readdir(slots)).toEqual([]);
  });

  it("fails, leaving nothing behind, when the source of the record is gone", async () => {
    await rm(source);

    await expect(claimFrom(context(3), cursor(), source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(slots)).toEqual([]);
  });

  it("fails, leaving nothing behind, when the link breaks for another reason", async () => {
    const files: NoteFiles = {
      ...nodeNoteFiles,
      link: async () => {
        throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
    };

    await expect(claimFrom(context(3, files), cursor(), source)).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(await readdir(slots)).toEqual([]);
  });

  it("stops before claiming when the signal is already aborted", async () => {
    await expect(
      claimFrom(context(3), cursor(), source, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await readdir(slots)).toEqual([]);
  });
});
