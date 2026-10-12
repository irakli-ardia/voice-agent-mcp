/** Abandoned handlers allowed before new executions are refused; the config default matches. */
export const DEFAULT_MAX_ABANDONED_TOOL_HANDLERS = 3;

/** One invoked handler. Both methods are idempotent, so a handler is never counted twice. */
export interface HandlerEntry {
  /** The executor stopped waiting (cancellation or timeout) while the handler is still running. */
  abandon(): void;
  /** The handler's own promise settled, whether or not anyone was still waiting for it. */
  settle(): void;
}

export interface HandlerCounts {
  /** Invoked and not yet settled, abandoned or not. */
  readonly unsettled: number;
  /** The unsettled handlers the executor is no longer waiting for. */
  readonly abandoned: number;
}

/**
 * Tracks every invoked tool handler until its own promise settles. JavaScript cannot stop a
 * handler, so after a timeout or cancellation it keeps running; the ledger bounds how many such
 * abandoned handlers may pile up and lets a shutdown wait for the rest. State is two counters and
 * one shared signal: nothing per call is retained.
 */
export interface HandlerLedger {
  /**
   * Registers a handler about to be invoked, or returns `undefined` when `maxAbandoned` handlers
   * are already abandoned, in which case the caller must not invoke it. Active (not yet abandoned)
   * handlers are not capped here: their number is bounded by whoever admits the calls.
   */
  enter(): HandlerEntry | undefined;
  /** Resolves when no invoked handler is unsettled; never rejects. Callers share one promise. */
  idle(): Promise<void>;
  counts(): HandlerCounts;
}

export function createHandlerLedger(options: { readonly maxAbandoned: number }): HandlerLedger {
  let unsettled = 0;
  let abandoned = 0;
  let idleSignal: PromiseWithResolvers<void> | undefined;

  return {
    enter: (): HandlerEntry | undefined => {
      if (abandoned >= options.maxAbandoned) {
        return undefined;
      }

      unsettled += 1;

      let isAbandoned = false;
      let isSettled = false;

      return {
        abandon: (): void => {
          if (!(isAbandoned || isSettled)) {
            isAbandoned = true;
            abandoned += 1;
          }
        },
        settle: (): void => {
          if (isSettled) {
            return;
          }

          isSettled = true;
          unsettled -= 1;

          if (isAbandoned) {
            abandoned -= 1;
          }

          if (unsettled === 0) {
            idleSignal?.resolve();
            idleSignal = undefined;
          }
        },
      };
    },
    idle: (): Promise<void> => {
      if (unsettled === 0) {
        return Promise.resolve();
      }

      idleSignal ??= Promise.withResolvers<void>();

      return idleSignal.promise;
    },
    counts: (): HandlerCounts => ({ unsettled, abandoned }),
  };
}
