import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "../../ports/logger.js";
import { errorCodeOf, type NoteFiles } from "./note-files.js";

/** A temp file this old is a crashed write's leftover; a live write takes milliseconds. */
export const TEMP_MAX_AGE_MS = 3_600_000;

/**
 * A claimed slot whose note was never published is rolled forward once it is this old. Age is not
 * proof that its writer is dead and nothing relies on it: rolling forward only publishes the very
 * file the writer would publish, exclusively, so a live writer finds its note already there and
 * returns it. The wait only spares a write still running from needless work.
 */
export const ROLL_FORWARD_AFTER_MS = 600_000;

export const NOTE_FILE = /^([0-9a-f]{32})\.json$/;

/** A slot is a directory named by its index alone, so claiming it is one exclusive `mkdir`. */
export const SLOT_NAME = /^(?:0|[1-9][0-9]{0,6})$/;

export const TEMP_NAME = /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A claim in preparation, before it is renamed to a slot: never counted, never published from. */
export const PREPARING_NAME =
  /^\.claim-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The record in a slot: a unique name, so no stale reference can ever name a newer claim's record. */
export const RECORD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Present once every note that existed before slots has a slot; created after a reconcile. */
export const READY_MARKER = ".ready";

/** What every slot operation needs. */
export interface SlotContext {
  readonly files: NoteFiles;
  readonly notesDirectory: string;
  readonly slotDirectory: string;
  /** Slots, so the most notes the store may hold. */
  readonly maxNotes: number;
  readonly logger: Logger;
  /** Milliseconds since the epoch; compared with file modification times. */
  readonly now: () => number;
}

/** Where the next claim starts looking: free slots are found near where they were last found. */
export interface SlotCursor {
  next: number;
}

/** A claim: the slot's index and the name of the record linked into it. */
export interface SlotClaim {
  readonly index: number;
  readonly record: string;
}

export function abortError(): DOMException {
  return new DOMException("The note store operation was aborted.", "AbortError");
}

export function slotPath(context: SlotContext, index: number): string {
  return join(context.slotDirectory, String(index));
}

export function recordPath(context: SlotContext, index: number, record: string): string {
  return join(slotPath(context, index), record);
}

/** Codes that only mean someone else got there first. */
const BENIGN_REMOVAL_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTEMPTY", "EEXIST"]);

/** Removes a file, reporting whether this call did; a file already gone is not an error. */
export async function removeQuietly(context: SlotContext, path: string): Promise<boolean> {
  try {
    await context.files.remove(path);

    return true;
  } catch (cause) {
    const code = errorCodeOf(cause);

    if (code !== "ENOENT") {
      context.logger.warn("note_store.temp_cleanup_failed", { errorCode: code });
    }

    return false;
  }
}

/** Removes a directory only if it is empty; anything else in it, or someone else's removal, is fine. */
export async function removeDirectoryQuietly(context: SlotContext, path: string): Promise<void> {
  try {
    await context.files.removeDirectory(path);
  } catch (cause) {
    const code = errorCodeOf(cause);

    if (!BENIGN_REMOVAL_CODES.has(code)) {
      context.logger.warn("note_store.temp_cleanup_failed", { errorCode: code });
    }
  }
}

/**
 * Frees a slot, but only if this call is the one that removes its record: reports whether it did.
 * A call whose record is already gone must not touch the directory, which may be a newer claimer's
 * (and a directory that is not empty would refuse anyway).
 */
export async function freeSlot(context: SlotContext, claim: SlotClaim): Promise<boolean> {
  if (!(await removeQuietly(context, recordPath(context, claim.index, claim.record)))) {
    return false;
  }

  await removeDirectoryQuietly(context, slotPath(context, claim.index));

  return true;
}

/** `rename` onto a slot that exists fails with one of these, which of them depends on the platform. */
const TAKEN_CODES: ReadonlySet<string> = new Set(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"]);

/**
 * Tries to make the prepared directory slot `index`: an atomic rename, which fails when a slot is
 * there. `taken`: a slot is there. `unclear`: the rename was refused as if a slot were there, but
 * none is to be seen: another claim is being renamed to that name at this very moment (Windows
 * refuses early), or the refusal is a real one; either way this pass cannot call the slot free or
 * taken. Any other failure is thrown.
 */
async function renameToSlot(
  context: SlotContext,
  prepared: string,
  index: number,
): Promise<"claimed" | "taken" | "unclear"> {
  const slot = slotPath(context, index);

  try {
    await context.files.rename(prepared, slot);

    return "claimed";
  } catch (cause) {
    if (!TAKEN_CODES.has(errorCodeOf(cause))) {
      throw cause;
    }

    return (await context.files.identityOf(slot)) === undefined ? "unclear" : "taken";
  }
}

/** Removes a prepared claim that did not become a slot: its record, then its directory. */
async function discardPrepared(
  context: SlotContext,
  prepared: string,
  record: string,
): Promise<void> {
  await removeQuietly(context, join(prepared, record));
  await removeDirectoryQuietly(context, prepared);
}

/** Prepares a claim: a private directory, not yet a slot, holding the record, a link to `source`. */
async function prepareClaim(
  context: SlotContext,
  source: string,
): Promise<{ readonly prepared: string; readonly record: string }> {
  const prepared = join(context.slotDirectory, `.claim-${randomUUID()}`);
  const record = randomUUID();

  await context.files.claimDirectory(prepared);

  try {
    await context.files.link(source, join(prepared, record));
  } catch (cause) {
    await removeDirectoryQuietly(context, prepared);

    throw cause;
  }

  return { prepared, record };
}

/** What one pass over the slots found: the slot it took, or how many it judged taken and which it could not judge. */
interface Pass {
  readonly index?: number;
  readonly taken: number;
  readonly unclear: readonly number[];
}

/**
 * Whether every index below `maxNotes` already has a slot directory: one listing instead of one
 * refused rename per slot. A full store is otherwise discovered by trying every index, which costs
 * about a millisecond each on Windows, so a refusal at the default quota took longer than the tool's
 * deadline and was never reported as a refusal. A slot directory that is only empty counts here and
 * is not taken, so this can call a store full that a retry finds room in, never the reverse.
 */
async function everySlotExists(context: SlotContext): Promise<boolean> {
  let count = 0;

  for (const entry of await context.files.listDirectory(context.slotDirectory)) {
    if (entry.isDirectory && SLOT_NAME.test(entry.name) && Number(entry.name) < context.maxNotes) {
      count += 1;
    }
  }

  return count >= context.maxNotes;
}

/** One pass over every index, starting at the cursor, renaming the prepared claim to the first free slot. */
async function passOver(
  context: SlotContext,
  cursor: SlotCursor,
  prepared: string,
  signal: AbortSignal | undefined,
): Promise<Pass> {
  // Fixed for the whole pass: a concurrent claim moves the cursor, and a pass that followed it
  // could skip free slots and wrongly find none.
  const start = cursor.next;
  const unclear: number[] = [];
  let taken = 0;
  let storeIsFull: Promise<boolean> | undefined;

  for (let step = 0; step < context.maxNotes; step += 1) {
    if (signal?.aborted === true) {
      throw abortError();
    }

    const index = (start + step) % context.maxNotes;
    const attempt = await renameToSlot(context, prepared, index);

    if (attempt === "claimed") {
      return { index, taken, unclear };
    }

    if (attempt === "unclear") {
      unclear.push(index);

      continue;
    }

    taken += 1;

    // The first slot found taken is the sign of a store that may be full: ask once per pass.
    storeIsFull ??= everySlotExists(context);

    if (await storeIsFull) {
      return { taken, unclear };
    }
  }

  return { taken, unclear };
}

/**
 * Renames the prepared claim to the first slot that is free: its index, or `undefined` when none
 * is. A slot that could not be judged is looked at again at the end, when whoever was renaming to it
 * has most likely finished. If it still cannot be judged it counts as taken, which can only refuse a
 * write that a retry accepts, unless nothing at all could be judged: then the rename itself is
 * failing, and this throws instead of calling the store full.
 */
async function takeSlot(
  context: SlotContext,
  cursor: SlotCursor,
  prepared: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const pass = await passOver(context, cursor, prepared, signal);

  if (pass.index !== undefined) {
    return pass.index;
  }

  for (const index of pass.unclear) {
    if ((await renameToSlot(context, prepared, index)) === "claimed") {
      return index;
    }
  }

  if (pass.taken === 0 && pass.unclear.length > 0) {
    throw Object.assign(new Error("No slot could be judged."), { code: "EBUSY" });
  }

  return undefined;
}

/**
 * Claims a slot. The claim is prepared first, privately, and taking a slot is then one atomic
 * `rename` of that directory to the slot's name, which fails if the slot exists. So a slot never
 * exists without its complete record, there is no moment at which a claim is half made, and nothing
 * can reach the record before the claim is whole. Returns `undefined` when no slot is free. An abort
 * stops the pass before a claim, never after one.
 *
 * Deletions only ever name a record by its unique name or remove a directory that is empty, so a
 * slow party holding a stale view can never delete a newer claim of the same index.
 */
export async function claimFrom(
  context: SlotContext,
  cursor: SlotCursor,
  source: string,
  signal?: AbortSignal,
): Promise<SlotClaim | undefined> {
  const { prepared, record } = await prepareClaim(context, source);

  try {
    const index = await takeSlot(context, cursor, prepared, signal);

    if (index !== undefined) {
      cursor.next = (index + 1) % context.maxNotes;

      return { index, record };
    }
  } catch (cause) {
    await discardPrepared(context, prepared, record);

    throw cause;
  }

  await discardPrepared(context, prepared, record);

  return undefined;
}
