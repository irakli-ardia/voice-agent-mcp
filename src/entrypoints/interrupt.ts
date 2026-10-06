/** The part of `process` the interrupt handler needs; tests pass an `EventEmitter`. */
export interface InterruptSource {
  once(event: "SIGINT", listener: () => void): void;
  off(event: "SIGINT", listener: () => void): void;
}

/**
 * Aborts `controller` on the first SIGINT so the turn can stop cleanly. The listener is registered
 * with `once`, so a second SIGINT gets Node's default behaviour and ends the process at once. The
 * returned function removes the listener if no signal arrived.
 */
export function onFirstInterrupt(source: InterruptSource, controller: AbortController): () => void {
  const abort = (): void => controller.abort();

  source.once("SIGINT", abort);

  return (): void => {
    source.off("SIGINT", abort);
  };
}
