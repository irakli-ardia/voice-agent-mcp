import type { Result } from "../domain/result.js";

/** `too_large`: the file holds more than the requested maximum; the rest is never read. */
export type AudioReadFailure = "unreadable" | "too_large";

/** `exists`: something already has that name; it is left untouched. */
export type AudioReserveFailure = "exists" | "failed";

/**
 * An output file this process created exclusively and has not yet committed. Nothing else is ever
 * overwritten through it.
 */
export interface ReservedAudioFile {
  /**
   * Writes `bytes` as the whole file and commits it (data synced, file closed). Once committed the
   * signal is ignored and the call resolves `ok`. Rejects only when `signal` aborts before the
   * commit point. After a failure or rejection nothing is committed and the caller discards.
   */
  write(bytes: Uint8Array, signal: AbortSignal): Promise<Result<void, "failed">>;
  /** Removes the file unless it was committed. Idempotent; never rejects. */
  discard(): Promise<void>;
}

/**
 * Local audio files named by the CLI user. Both methods reject only when `signal` aborts; a
 * rejection leaves no reserved file behind and never carries a path or system detail.
 */
export interface AudioFiles {
  /** The file's bytes, read only while they fit in `maxBytes`. */
  read(
    path: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<Result<Uint8Array, AudioReadFailure>>;
  /** Creates `path` exclusively, never replacing anything, and never creating directories. */
  reserve(
    path: string,
    signal: AbortSignal,
  ): Promise<Result<ReservedAudioFile, AudioReserveFailure>>;
}
