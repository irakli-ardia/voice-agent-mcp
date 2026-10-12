import { describe, expect, it } from "vitest";
import {
  createHandlerLedger,
  DEFAULT_MAX_ABANDONED_TOOL_HANDLERS,
  type HandlerEntry,
} from "../../../../src/app/tools/handler-ledger.js";

function entered(entry: HandlerEntry | undefined): HandlerEntry {
  if (entry === undefined) {
    throw new Error("The ledger refused an entry that was expected to be admitted.");
  }

  return entry;
}

describe("createHandlerLedger", () => {
  it("defaults to three abandoned handlers", () => {
    expect(DEFAULT_MAX_ABANDONED_TOOL_HANDLERS).toBe(3);
  });

  it("starts empty and idle", async () => {
    const ledger = createHandlerLedger({ maxAbandoned: 3 });

    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    await expect(ledger.idle()).resolves.toBeUndefined();
  });

  it("counts an active handler as unsettled, not abandoned", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 3 });

    entered(ledger.enter());

    expect(ledger.counts()).toEqual({ unsettled: 1, abandoned: 0 });
  });

  it("leaves the ledger only when the handler settles", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 3 });
    const entry = entered(ledger.enter());

    entry.abandon();

    expect(ledger.counts()).toEqual({ unsettled: 1, abandoned: 1 });

    entry.settle();

    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("settles an active handler without ever abandoning it", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 3 });

    entered(ledger.enter()).settle();

    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("counts an entry once however often it is abandoned or settled", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 3 });
    const first = entered(ledger.enter());
    const second = entered(ledger.enter());

    first.abandon();
    first.abandon();

    expect(ledger.counts()).toEqual({ unsettled: 2, abandoned: 1 });

    first.settle();
    first.settle();

    expect(ledger.counts()).toEqual({ unsettled: 1, abandoned: 0 });

    second.settle();

    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("ignores an abandon that arrives after the handler settled", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 3 });
    const entry = entered(ledger.enter());

    entry.settle();
    entry.abandon();

    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("refuses an entry once the abandoned limit is reached, and counts nothing for it", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 2 });

    entered(ledger.enter()).abandon();
    entered(ledger.enter()).abandon();

    expect(ledger.enter()).toBeUndefined();
    expect(ledger.counts()).toEqual({ unsettled: 2, abandoned: 2 });
  });

  it("recovers as soon as one abandoned handler settles", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 2 });
    const first = entered(ledger.enter());

    first.abandon();
    entered(ledger.enter()).abandon();

    expect(ledger.enter()).toBeUndefined();

    first.settle();

    expect(ledger.enter()).toBeDefined();
  });

  it("does not cap active handlers", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 1 });

    for (let index = 0; index < 50; index += 1) {
      entered(ledger.enter());
    }

    expect(ledger.counts()).toEqual({ unsettled: 50, abandoned: 0 });
  });

  it("is not full until the limit, whatever the number of unabandoned handlers", () => {
    const ledger = createHandlerLedger({ maxAbandoned: 3 });

    entered(ledger.enter()).abandon();
    entered(ledger.enter()).abandon();

    expect(ledger.enter()).toBeDefined();
  });

  it("keeps ledgers independent: there is no shared state", () => {
    const one = createHandlerLedger({ maxAbandoned: 1 });
    const other = createHandlerLedger({ maxAbandoned: 1 });

    entered(one.enter()).abandon();

    expect(one.enter()).toBeUndefined();
    expect(other.enter()).toBeDefined();
  });

  describe("idle", () => {
    it("stays pending while any handler is unsettled, abandoned or not", async () => {
      const ledger = createHandlerLedger({ maxAbandoned: 3 });
      const entry = entered(ledger.enter());
      let resolved = false;

      void ledger.idle().then(() => {
        resolved = true;
      });
      entry.abandon();
      await Promise.resolve();

      expect(resolved).toBe(false);

      entry.settle();
      await Promise.resolve();

      expect(resolved).toBe(true);
    });

    it("resolves only when the last of several handlers settles", async () => {
      const ledger = createHandlerLedger({ maxAbandoned: 3 });
      const first = entered(ledger.enter());
      const second = entered(ledger.enter());
      let resolved = false;

      void ledger.idle().then(() => {
        resolved = true;
      });
      first.settle();
      await Promise.resolve();

      expect(resolved).toBe(false);

      second.settle();
      await Promise.resolve();

      expect(resolved).toBe(true);
    });

    it("gives every caller the same pending promise, so waiters cannot pile up", () => {
      const ledger = createHandlerLedger({ maxAbandoned: 3 });

      entered(ledger.enter());

      expect(ledger.idle()).toBe(ledger.idle());
    });

    it("starts a fresh signal after going idle and busy again", async () => {
      const ledger = createHandlerLedger({ maxAbandoned: 3 });
      const first = entered(ledger.enter());
      const before = ledger.idle();

      first.settle();
      await before;

      const second = entered(ledger.enter());
      let resolved = false;

      void ledger.idle().then(() => {
        resolved = true;
      });
      await Promise.resolve();

      expect(resolved).toBe(false);

      second.settle();
      await Promise.resolve();

      expect(resolved).toBe(true);
    });

    it("is already resolved when nothing is unsettled", async () => {
      const ledger = createHandlerLedger({ maxAbandoned: 3 });

      entered(ledger.enter()).settle();

      await expect(ledger.idle()).resolves.toBeUndefined();
    });
  });

  it("matches a reference model over 20 000 seeded random operations", async () => {
    const model = createModelCheck(3);

    for (let step = 0; step < 20_000; step += 1) {
      model.step();
    }

    expect(model.problems).toEqual([]);

    model.settleAll();

    expect(model.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    await expect(model.ledger.idle()).resolves.toBeUndefined();
  });
});

interface LiveEntry {
  readonly entry: HandlerEntry;
  abandoned: boolean;
}

/** Drives a ledger with seeded random operations beside a plain-array model, recording any drift. */
function createModelCheck(limit: number) {
  const ledger = createHandlerLedger({ maxAbandoned: limit });
  const live: LiveEntry[] = [];
  const problems: string[] = [];
  let seed = 12_345;

  const random = (): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;

    return seed / 2 ** 32;
  };

  const pick = (): LiveEntry | undefined => live[Math.floor(random() * live.length)];
  const abandonedCount = (): number => live.filter((item) => item.abandoned).length;

  const enter = (): void => {
    const entry = ledger.enter();

    if ((entry === undefined) !== abandonedCount() >= limit) {
      problems.push("refusal does not match the limit");
    }

    if (entry !== undefined) {
      live.push({ entry, abandoned: false });
    }
  };

  const abandon = (): void => {
    const item = pick();

    if (item !== undefined) {
      item.entry.abandon();
      item.entry.abandon();
      item.abandoned = true;
    }
  };

  const settle = (): void => {
    const item = pick();

    if (item !== undefined) {
      live.splice(live.indexOf(item), 1);
      item.entry.settle();
      item.entry.settle();
    }
  };

  return {
    ledger,
    problems,
    step: (): void => {
      const dice = random();

      if (dice < 0.35) {
        enter();
      } else if (dice < 0.55) {
        abandon();
      } else {
        settle();
      }

      const counts = ledger.counts();

      if (counts.unsettled !== live.length || counts.abandoned !== abandonedCount()) {
        problems.push(`counts drifted: ${JSON.stringify(counts)} vs ${live.length}`);
      }
    },
    settleAll: (): void => {
      for (const item of live.splice(0)) {
        item.entry.settle();
      }
    },
  };
}
