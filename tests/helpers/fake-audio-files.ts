import { err, ok, type Result } from "../../src/domain/result.js";
import type {
  AudioFiles,
  AudioReadFailure,
  AudioReserveFailure,
  ReservedAudioFile,
} from "../../src/ports/audio-files.js";

/** What happened to one reserved output file. */
export interface FakeReservation {
  state: "reserved" | "committed" | "discarded";
  bytes: Uint8Array | null;
}

export interface FakeAudioFilesOptions {
  /** Existing files: readable as input, and names a reservation can never take. */
  readonly files?: ReadonlyMap<string, Uint8Array>;
  /** Replaces the default read, for reads a well-behaved adapter would never return. */
  readonly read?: AudioFiles["read"] | undefined;
  /** Runs inside `reserve` after its entry abort check and before the file is created. */
  readonly beforeReserve?: (signal: AbortSignal) => Promise<void>;
  /** Makes `reserve` fail with `failed` (a missing directory, no permission). */
  readonly reserveFails?: boolean;
  /** Runs inside `write` after its entry abort check and before the commit point. */
  readonly beforeCommit?: (signal: AbortSignal) => Promise<void>;
  /** Makes `write` fail with `failed` before the commit point (a full disk). */
  readonly writeFails?: boolean;
  /** Breaks the port contract: `discard` rejects. */
  readonly discardRejects?: boolean;
}

export interface FakeAudioFiles extends AudioFiles {
  /** Reserved output files by path. */
  readonly reservations: ReadonlyMap<string, FakeReservation>;
  readonly calls: { read: number; reserve: number; write: number; discard: number };
}

/**
 * In-memory `AudioFiles` that keeps the port contract: bounded reads, exclusive reservations that
 * never replace an existing name, a commit point after which the signal is ignored, an idempotent
 * discard that never removes a committed file, and rejections only for an abort.
 */
export function createFakeAudioFiles(options: FakeAudioFilesOptions = {}): FakeAudioFiles {
  const files = options.files ?? new Map<string, Uint8Array>();
  const reservations = new Map<string, FakeReservation>();
  const calls = { read: 0, reserve: 0, write: 0, discard: 0 };

  const read = async (
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, AudioReadFailure>> => {
    calls.read += 1;

    if (options.read !== undefined) {
      return options.read(path, maxBytes, signal);
    }

    signal.throwIfAborted();

    const bytes = files.get(path);

    if (bytes === undefined) {
      return err("unreadable");
    }

    return bytes.byteLength > maxBytes ? err("too_large") : ok(bytes);
  };

  const reservedFile = (reservation: FakeReservation): ReservedAudioFile => ({
    write: async (bytes: Uint8Array, signal: AbortSignal): Promise<Result<void, "failed">> => {
      calls.write += 1;
      signal.throwIfAborted();
      await options.beforeCommit?.(signal);

      if (options.writeFails === true) {
        return err("failed");
      }

      reservation.state = "committed";
      reservation.bytes = bytes;

      return ok(undefined);
    },
    discard: async (): Promise<void> => {
      calls.discard += 1;

      if (options.discardRejects === true) {
        throw new Error("discard failed");
      }

      if (reservation.state === "reserved") {
        reservation.state = "discarded";
      }
    },
  });

  const reserve = async (
    path: string,
    signal: AbortSignal,
  ): Promise<Result<ReservedAudioFile, AudioReserveFailure>> => {
    calls.reserve += 1;
    signal.throwIfAborted();
    await options.beforeReserve?.(signal);

    if (files.has(path) || reservations.has(path)) {
      return err("exists");
    }

    if (options.reserveFails === true) {
      return err("failed");
    }

    const reservation: FakeReservation = { state: "reserved", bytes: null };

    reservations.set(path, reservation);

    return ok(reservedFile(reservation));
  };

  return { reservations, calls, read, reserve };
}
