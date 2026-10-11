export interface CommitGate {
  /** Pass as the fake note store's `beforeCommit`: holds each write inside its commit window. */
  readonly beforeCommit: (callIndex: number) => Promise<void>;
  /** Indices of the writes that have entered the window, in order. */
  readonly entered: readonly number[];
  /** Resolves once `count` writes are inside the window. */
  whenEntered(count: number): Promise<void>;
  /** Lets one write commit; may be called before it enters. */
  release(callIndex: number): void;
}

/** Holds writes between "started" and "committed" until the test lets each one go. */
export function createCommitGate(): CommitGate {
  const gates = new Map<number, PromiseWithResolvers<void>>();
  const entered: number[] = [];
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];

  const gateFor = (callIndex: number): PromiseWithResolvers<void> => {
    const existing = gates.get(callIndex);

    if (existing !== undefined) {
      return existing;
    }

    const created = Promise.withResolvers<void>();

    gates.set(callIndex, created);

    return created;
  };

  return {
    entered,
    beforeCommit: async (callIndex: number): Promise<void> => {
      entered.push(callIndex);

      for (const waiter of waiters) {
        if (entered.length >= waiter.count) {
          waiter.resolve();
        }
      }

      await gateFor(callIndex).promise;
    },
    whenEntered: async (count: number): Promise<void> => {
      if (entered.length >= count) {
        return;
      }

      await new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
    release: (callIndex: number): void => gateFor(callIndex).resolve(),
  };
}
