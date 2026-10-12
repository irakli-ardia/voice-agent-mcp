import { join } from "node:path";
import { errorCodeOf, sameFile } from "./note-files.js";
import { reconcileSlots, sweepTemp } from "./note-reconcile.js";
import {
  claimFrom,
  freeSlot,
  READY_MARKER,
  recordPath,
  SLOT_NAME,
  type SlotClaim,
  type SlotContext,
  type SlotCursor,
} from "./note-slot-layout.js";

/** After a full pass found no free slot, how long before looking again. */
const FULL_RECHECK_MS = 1_000;

/** The most often a full store pays for a whole-store reconcile. */
const RECONCILE_MIN_INTERVAL_MS = 10_000;

export type NoteSlotsOptions = SlotContext;

export type ClaimOutcome =
  | {
      readonly status: "claimed";
      /** Whether the note at `notePath` is this claim's own file: the slot backs that note. */
      holds(notePath: string): Promise<boolean>;
      /**
       * Frees the slot. Only for a write that lost the race to publish: a note that exists and is
       * not this claim's file can never be published from the record, so nothing is lost. A record
       * that might still be published is never released.
       */
      release(): Promise<void>;
    }
  | { readonly status: "full" };

/**
 * The note quota. A slot is a hard link, named by an index below `maxNotes`, to a complete note
 * record; a note is only ever published from a slot. Linking is exclusive and atomic, so however many
 * writers and processes race, at most `maxNotes` slots exist, and so at most `maxNotes` notes.
 *
 * A slot is claimed with the record already complete and fsynced, so a slot is never empty-handed:
 * if its writer dies before publishing the note, any process can publish it from the slot. Claiming
 * is a quota reservation plus a durable record of intent, not a published note. Nothing here needs
 * to know whether a writer is alive.
 */
export interface NoteSlots {
  /**
   * Once per process, after both directories exist: checks the slot directory, accounts for notes
   * that predate slots, publishes and prunes slots when the store was never reconciled, removes
   * old temp files, and finds where free slots start.
   */
  initialize(): Promise<void>;
  /** Claims a free slot by linking `source` (a complete record) into it. */
  claim(source: string, signal: AbortSignal): Promise<ClaimOutcome>;
}

export function createNoteSlots(context: NoteSlotsOptions): NoteSlots {
  const cursor: SlotCursor = { next: 0 };
  let fullUntil = 0;
  let lastReconcileAt = Number.NEGATIVE_INFINITY;

  const claimed = (claim: SlotClaim): ClaimOutcome => ({
    status: "claimed",
    holds: async (notePath: string): Promise<boolean> => {
      const [record, note] = await Promise.all([
        context.files.identityOf(recordPath(context, claim.index, claim.record)),
        context.files.identityOf(notePath),
      ]);

      return record !== undefined && note !== undefined && sameFile(record, note);
    },
    release: async (): Promise<void> => {
      await freeSlot(context, claim);
    },
  });

  const reconcileOnce = async (): Promise<void> => {
    await reconcileSlots(context, cursor);

    await context.files
      .createMarker(join(context.slotDirectory, READY_MARKER))
      .catch((cause: unknown) => {
        if (errorCodeOf(cause) !== "EEXIST") {
          throw cause;
        }
      });
  };

  return {
    initialize: async (): Promise<void> => {
      const directory = await context.files.identityOf(context.slotDirectory);

      // A link in its place could point the slots anywhere.
      if (directory?.isDirectory !== true) {
        throw Object.assign(new Error("The slot directory is not a directory."), {
          code: "EINVAL",
        });
      }

      if (
        (await context.files.identityOf(join(context.slotDirectory, READY_MARKER))) === undefined
      ) {
        await reconcileOnce();
      }

      await sweepTemp(context);

      const slots = (await context.files.listDirectory(context.slotDirectory)).filter(
        (entry) => entry.isDirectory && SLOT_NAME.test(entry.name),
      );

      cursor.next = slots.length % context.maxNotes;
    },
    claim: async (source: string, signal: AbortSignal): Promise<ClaimOutcome> => {
      const first =
        context.now() >= fullUntil ? await claimFrom(context, cursor, source, signal) : undefined;

      if (first !== undefined) {
        return claimed(first);
      }

      fullUntil = context.now() + FULL_RECHECK_MS;

      // Full as far as this pass can see: slots no note needs may be freed, so look once in a while.
      if (context.now() - lastReconcileAt < RECONCILE_MIN_INTERVAL_MS) {
        return { status: "full" };
      }

      lastReconcileAt = context.now();
      await reconcileSlots(context, cursor);

      const second = await claimFrom(context, cursor, source, signal);

      if (second === undefined) {
        return { status: "full" };
      }

      fullUntil = 0;

      return claimed(second);
    },
  };
}
