import { join } from "node:path";
import { errorCodeOf, type FileIdentity, sameFile } from "./note-files.js";
import { decodeRecord, MAX_RECORD_BYTES, noteIdFor } from "./note-record.js";
import {
  abortError,
  claimFrom,
  freeSlot,
  NOTE_FILE,
  PREPARING_NAME,
  RECORD_NAME,
  ROLL_FORWARD_AFTER_MS,
  recordPath,
  removeDirectoryQuietly,
  removeQuietly,
  SLOT_NAME,
  type SlotContext,
  type SlotCursor,
  slotPath,
  TEMP_MAX_AGE_MS,
  TEMP_NAME,
} from "./note-slot-layout.js";

/** One record in one slot, as it was when read. */
interface SlotRecord {
  readonly index: number;
  readonly record: string;
  readonly identity: FileIdentity;
}

/**
 * A record file in a slot, and the note it belongs to when it is a valid record of its own note.
 * `undefined` for something that is not a regular file, which backs nothing.
 */
type ReadRecord = { readonly noteId: string | undefined; readonly slot: SlotRecord } | undefined;

/** What reading the slots found: valid records by the note they belong to, in index order. */
interface SlotScan {
  readonly groups: ReadonlyMap<string, readonly SlotRecord[]>;
  /** Every record file seen, valid or not: a note that is one of them has its slot. */
  readonly backing: readonly FileIdentity[];
  readonly unreadable: number;
  /** Empty slot directories old enough to reclaim, which were removed. */
  readonly reclaimed: number;
}

/** Slot directories read at once. */
const READ_BATCH = 16;

async function readRecord(
  context: SlotContext,
  index: number,
  record: string,
): Promise<ReadRecord> {
  const path = recordPath(context, index, record);

  try {
    const identity = await context.files.identityOf(path);

    if (identity?.isFile !== true) {
      return undefined;
    }

    const read = await context.files.readAtMost(
      path,
      MAX_RECORD_BYTES,
      new AbortController().signal,
    );

    const decoded = read.ok ? decodeRecord(read.value) : undefined;
    const slot = { index, record, identity };

    // A record that is not a valid record of its own note is left alone, and keeps its place.
    if (decoded?.ok !== true || noteIdFor(decoded.value.idempotencyKey) !== decoded.value.noteId) {
      return { noteId: undefined, slot };
    }

    return { noteId: decoded.value.noteId, slot };
  } catch {
    return undefined;
  }
}

/** Reads one slot directory: its records, or reclaims it when it is empty and old. */
async function readSlot(
  context: SlotContext,
  index: number,
): Promise<{ readonly found: readonly ReadRecord[]; readonly reclaimed: boolean }> {
  const names = (await context.files.listDirectory(slotPath(context, index)))
    .filter((entry) => entry.isFile && RECORD_NAME.test(entry.name))
    .map((entry) => entry.name);

  if (names.length > 0) {
    const found = await Promise.all(names.map(async (name) => readRecord(context, index, name)));

    return { found, reclaimed: false };
  }

  // With no record, a slot directory is only what a release left behind: nothing claims it half made.
  await removeDirectoryQuietly(context, slotPath(context, index));

  return { found: [], reclaimed: true };
}

/** Files one record read from a slot into the scan. */
function tally(
  scan: {
    unreadable: number;
    readonly backing: FileIdentity[];
    readonly groups: Map<string, SlotRecord[]>;
  },
  found: ReadRecord,
): void {
  if (found === undefined) {
    scan.unreadable += 1;

    return;
  }

  scan.backing.push(found.slot.identity);

  if (found.noteId === undefined) {
    scan.unreadable += 1;
  } else {
    scan.groups.set(found.noteId, [...(scan.groups.get(found.noteId) ?? []), found.slot]);
  }
}

async function scanSlots(
  context: SlotContext,
  indexes: readonly number[],
  signal: AbortSignal | undefined,
): Promise<SlotScan> {
  const scan = { groups: new Map<string, SlotRecord[]>(), backing: [], unreadable: 0 };
  let reclaimed = 0;

  for (let start = 0; start < indexes.length; start += READ_BATCH) {
    // Safe to stop between batches: nothing here has changed anything a repeat would not redo.
    if (signal?.aborted === true) {
      throw abortError();
    }

    const batch = indexes.slice(start, start + READ_BATCH);

    for (const slot of await Promise.all(batch.map(async (index) => readSlot(context, index)))) {
      reclaimed += slot.reclaimed ? 1 : 0;

      for (const found of slot.found) {
        tally(scan, found);
      }
    }
  }

  return { ...scan, reclaimed };
}

/**
 * Publishes a note from its lowest slot record by linking it to the note's name: exclusive, so at
 * most once however many try. `skipped`: too recent to touch. `failed`: nothing was published.
 * `done`: it is published now, by someone else. `published`: by this call. No one removes a record
 * that could still be published (see `removeSurplus`), so this never races a removal.
 */
async function publishFrom(
  context: SlotContext,
  lowest: SlotRecord | undefined,
  target: string,
): Promise<"done" | "skipped" | "failed" | "published"> {
  if (lowest === undefined || context.now() - lowest.identity.modifiedMs < ROLL_FORWARD_AFTER_MS) {
    return "skipped";
  }

  try {
    await context.files.link(recordPath(context, lowest.index, lowest.record), target);

    return "published";
  } catch (cause) {
    const code = errorCodeOf(cause);

    // EEXIST: someone published it first. ENOENT: the record was freed meanwhile as surplus.
    if (code === "EEXIST") {
      return "done";
    }

    if (code !== "ENOENT") {
      context.logger.warn("note_store.unavailable", {
        operation: "reconcile",
        phase: "link",
        errorCode: code,
      });
    }

    return "failed";
  }
}

/** Frees every record of the group that is not the same file as the note: they lost the race. */
async function removeSurplus(
  context: SlotContext,
  slots: readonly SlotRecord[],
  note: FileIdentity,
): Promise<number> {
  const keeper = slots.find((slot) => sameFile(slot.identity, note));
  let removed = 0;

  for (const slot of slots) {
    if (slot !== keeper) {
      await freeSlot(context, slot);
      removed += 1;
    }
  }

  return removed;
}

/** What one group of slot records needed: a publication, and how many surplus records went. */
async function reconcileGroup(
  context: SlotContext,
  noteId: string,
  slots: readonly SlotRecord[],
): Promise<{ readonly published: number; readonly removed: number }> {
  const target = join(context.notesDirectory, `${noteId}.json`);
  let note = await context.files.identityOf(target);
  let published = 0;

  if (note === undefined) {
    const outcome = await publishFrom(context, slots[0], target);

    if (outcome === "skipped" || outcome === "failed") {
      return { published: 0, removed: 0 };
    }

    published = outcome === "published" ? 1 : 0;
    note = await context.files.identityOf(target);
  }

  return { published, removed: note === undefined ? 0 : await removeSurplus(context, slots, note) };
}

/** Gives every note that has no slot (made before slots existed) one; reports who got none. */
async function accountLegacyNotes(
  context: SlotContext,
  cursor: SlotCursor,
  noteNames: readonly string[],
  known: ReadonlyMap<string, readonly SlotRecord[]>,
  backing: readonly FileIdentity[],
): Promise<{ readonly accounted: number; readonly unaccounted: number }> {
  let accounted = 0;
  let unaccounted = 0;

  for (const name of noteNames) {
    const noteId = NOTE_FILE.exec(name)?.[1];

    if (noteId === undefined || known.has(noteId)) {
      continue;
    }

    const path = join(context.notesDirectory, name);
    const note = await context.files.identityOf(path);

    // A note that is a record file, even an unreadable one, already has its slot.
    if (note === undefined || backing.some((record) => sameFile(record, note))) {
      continue;
    }

    const claim = await claimFrom(context, cursor, path);

    accounted += claim === undefined ? 0 : 1;
    unaccounted += claim === undefined ? 1 : 0;
  }

  return { accounted, unaccounted };
}

/**
 * Brings the slots and the notes into agreement. Every step is safe at any moment and to repeat, by
 * any number of processes, whatever the writers are doing:
 *
 * - A note's slot is the record that is the same file as the note. Any other record for that note
 *   lost the race to publish it and is freed (its writer, if alive, will find the note and leave).
 * - A slot record with no note is published from once it is old enough. That only completes what
 *   its writer was about to do.
 * - A note with no slot gets one, by linking the note into a free slot.
 * - A record that is not a valid record is never touched, and its note counts as having its slot.
 * - An empty slot directory is a claim that never got its record; once old enough it is removed.
 *
 * No step frees a record that backs a note, and every removal names a record by its unique name or
 * removes an empty directory, so recovery cannot let the store exceed its quota.
 */
export async function reconcileSlots(
  context: SlotContext,
  cursor: SlotCursor,
  signal?: AbortSignal,
): Promise<void> {
  const noteNames = (await context.files.listDirectory(context.notesDirectory))
    .filter((entry) => entry.isFile && NOTE_FILE.test(entry.name))
    .map((entry) => entry.name);

  // Notes are listed before slots: a slot record always exists before its note, so every note listed
  // above has its record in the scan below, unless it never had one.
  const indexes = (await context.files.listDirectory(context.slotDirectory))
    .filter((entry) => entry.isDirectory && SLOT_NAME.test(entry.name))
    .map((entry) => Number(entry.name))
    .sort((left, right) => left - right);

  const { groups, backing, unreadable, reclaimed } = await scanSlots(context, indexes, signal);
  let published = 0;
  let removed = 0;

  for (const [noteId, slots] of groups) {
    const outcome = await reconcileGroup(context, noteId, slots);

    published += outcome.published;
    removed += outcome.removed;
  }

  const { accounted, unaccounted } = await accountLegacyNotes(
    context,
    cursor,
    noteNames,
    groups,
    backing,
  );

  // Giving old notes their slots is routine; only what needed repair or could not be fixed is news.
  if (published + removed + reclaimed + unaccounted + unreadable > 0) {
    context.logger.info("note_store.reconciled", {
      published,
      removed: removed + reclaimed,
      accounted,
      unaccounted,
      unreadable,
    });
  }
}

/** Removes a claim being prepared: its record, if any, then its directory. */
async function removePreparing(context: SlotContext, path: string): Promise<void> {
  for (const inner of await context.files.listDirectory(path)) {
    if (inner.isFile && RECORD_NAME.test(inner.name)) {
      await removeQuietly(context, join(path, inner.name));
    }
  }

  await removeDirectoryQuietly(context, path);
}

/** A claim being prepared is a directory with at most its one record, outside the slots. */
async function sweepPreparing(context: SlotContext): Promise<number> {
  let swept = 0;

  for (const entry of await context.files.listDirectory(context.slotDirectory)) {
    const path = join(context.slotDirectory, entry.name);

    const identity =
      entry.isDirectory && PREPARING_NAME.test(entry.name)
        ? await context.files.identityOf(path)
        : undefined;

    if (identity?.isDirectory === true && context.now() - identity.modifiedMs >= TEMP_MAX_AGE_MS) {
      await removePreparing(context, path);
      swept += 1;
    }
  }

  return swept;
}

/**
 * Removes the leftovers of crashed writes once they are old enough: temp files, and claims that
 * were being prepared (neither is counted by the quota or published from). A live write that loses
 * one fails before it publishes anything.
 */
export async function sweepTemp(context: SlotContext): Promise<void> {
  let swept = await sweepPreparing(context);

  for (const entry of await context.files.listDirectory(context.notesDirectory)) {
    if (!(entry.isFile && TEMP_NAME.test(entry.name))) {
      continue;
    }

    const path = join(context.notesDirectory, entry.name);
    const identity = await context.files.identityOf(path);
    const old = identity?.isFile === true && context.now() - identity.modifiedMs >= TEMP_MAX_AGE_MS;

    if (old && (await removeQuietly(context, path))) {
      swept += 1;
    }
  }

  if (swept > 0) {
    context.logger.info("note_store.temp_swept", { removed: swept });
  }
}
