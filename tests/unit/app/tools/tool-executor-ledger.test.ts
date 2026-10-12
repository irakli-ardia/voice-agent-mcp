import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createHandlerLedger,
  type HandlerLedger,
} from "../../../../src/app/tools/handler-ledger.js";
import { createToolExecutor, type ToolExecutor } from "../../../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../../../src/app/tools/tool-registry.js";
import type { JsonObject } from "../../../../src/domain/json-value.js";
import type { Result } from "../../../../src/domain/result.js";
import type { ToolExecutionError } from "../../../../src/domain/tool-execution-error.js";
import { defineTool, type ToolDefinition } from "../../../../src/tools/tool-definition.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import { createGatedTool, type GatedTool } from "../../../helpers/gated-tool.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";

/** `createGatedTool`'s handler deadline. */
const TIMEOUT_MS = 10_000;

const realSetImmediate = setImmediate;

type Outcome = Result<JsonObject, ToolExecutionError>;

interface Harness {
  readonly gated: GatedTool;
  readonly ledger: HandlerLedger;
  readonly logger: RecordingLogger;
  readonly execute: ToolExecutor;
  /** Starts a call to the gated tool; `signal` defaults to one that never aborts. */
  call(label: string, signal?: AbortSignal): Promise<Outcome>;
}

function harness(maxAbandoned = 3, extra: readonly ToolDefinition[] = []): Harness {
  const gated = createGatedTool({ honorsSignal: false });
  const ledger = createHandlerLedger({ maxAbandoned });
  const logger = createRecordingLogger();

  const execute = createToolExecutor({
    registry: createToolRegistry([gated.tool, ...extra]),
    clock: createFakeClock(),
    logger,
    maxResultBytes: 1_000,
    handlerLedger: ledger,
  });

  let id = 0;

  return {
    gated,
    ledger,
    logger,
    execute,
    call: (label, signal = new AbortController().signal) => {
      id += 1;

      return execute({ id: `call-${id}`, name: "gated", arguments: { label } }, signal);
    },
  };
}

function codeOf(result: Outcome): string {
  return result.ok ? "ok" : result.error.code;
}

/** Lets promise continuations run without moving the fake clock. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Abandons `labels` one by one: each is held past its deadline, so its handler keeps running. */
async function abandon(h: Harness, labels: readonly string[]): Promise<void> {
  for (const label of labels) {
    const pending = h.call(label);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(codeOf(await pending)).toBe("timed_out");
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  const leakedTimers = vi.getTimerCount();

  vi.useRealTimers();

  if (leakedTimers > 0) {
    throw new Error(`The test left ${leakedTimers} timer(s) running.`);
  }
});

describe("executor ledger accounting", () => {
  it("holds an active handler as unsettled and clears it when the handler returns", async () => {
    const h = harness();
    const pending = h.call("a");

    await h.gated.whenStarted(1);

    expect(h.ledger.counts()).toEqual({ unsettled: 1, abandoned: 0 });

    h.gated.release("a");

    expect(codeOf(await pending)).toBe("ok");
    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("never enters a call that fails validation", async () => {
    const h = harness();

    const result = await h.execute(
      { id: "call-x", name: "gated", arguments: { label: 7 } },
      new AbortController().signal,
    );

    expect(codeOf(result)).toBe("invalid_input");
    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("never enters an unknown tool", async () => {
    const h = harness();

    const result = await h.execute(
      { id: "call-x", name: "missing", arguments: {} },
      new AbortController().signal,
    );

    expect(codeOf(result)).toBe("unknown_tool");
    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("clears a handler that throws, rejects, or throws synchronously", async () => {
    const tool = (name: string, execute: () => Promise<never>): ToolDefinition =>
      defineTool({
        name,
        description: "Fails.",
        risk: "read",
        requiresConfirmation: false,
        idempotency: "none",
        timeoutMs: TIMEOUT_MS,
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({}),
        failures: {},
        execute,
      });

    const h = harness(3, [
      tool("rejects", () => Promise.reject(new Error("boom"))),
      tool("throws", () => {
        throw new TypeError("sync boom");
      }),
    ]);

    for (const name of ["rejects", "throws"]) {
      const result = await h.execute(
        { id: name, name, arguments: {} },
        new AbortController().signal,
      );

      expect(codeOf(result)).toBe("internal_error");
      expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    }
  });

  it("clears a handler that throws before returning a promise", async () => {
    // `defineTool` always returns an async handler; a hand-built definition need not.
    const base = createGatedTool().tool;

    const syncThrower: ToolDefinition = {
      ...base,
      name: "sync_thrower",
      bindArguments: () => ({
        ok: true,
        value: () => {
          throw new TypeError("thrown before a promise exists");
        },
      }),
    };

    const h = harness(3, [syncThrower]);

    const result = await h.execute(
      { id: "sync", name: "sync_thrower", arguments: {} },
      new AbortController().signal,
    );

    expect(codeOf(result)).toBe("internal_error");
    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("marks a handler abandoned at its deadline, and keeps it until it settles", async () => {
    const h = harness();
    const pending = h.call("a");

    await h.gated.whenStarted(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);

    expect(h.ledger.counts()).toEqual({ unsettled: 1, abandoned: 0 });

    await vi.advanceTimersByTimeAsync(1);

    expect(codeOf(await pending)).toBe("timed_out");
    expect(h.ledger.counts()).toEqual({ unsettled: 1, abandoned: 1 });

    h.gated.release("a");
    await flush();

    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("does not abandon a handler that settles just before the deadline", async () => {
    const h = harness();
    const pending = h.call("a");

    await h.gated.whenStarted(1);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    h.gated.release("a");

    expect(codeOf(await pending)).toBe("ok");
    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("counts a handler that settles in the same turn as its deadline as settled, not abandoned", async () => {
    const h = harness();
    const pending = h.call("a");

    await h.gated.whenStarted(1);

    // The release is a pending microtask when the timer fires: the deadline wins the result, but
    // the handler's own settlement still runs before the executor looks at the ledger.
    h.gated.release("a");
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(codeOf(await pending)).toBe("timed_out");
    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("does not enter a call cancelled before invocation, even at the limit", async () => {
    const h = harness(1);

    await abandon(h, ["a"]);

    const cancelled = new AbortController();

    cancelled.abort();

    expect(codeOf(await h.call("b", cancelled.signal))).toBe("cancelled");
    expect(h.gated.started).toEqual(["a"]);
    expect(h.ledger.counts()).toEqual({ unsettled: 1, abandoned: 1 });
  });

  it("abandons a handler cancelled during execution, and keeps it until it settles", async () => {
    const h = harness();
    const cancel = new AbortController();
    const pending = h.call("a", cancel.signal);

    await h.gated.whenStarted(1);
    cancel.abort();

    expect(codeOf(await pending)).toBe("cancelled");
    expect(h.ledger.counts()).toEqual({ unsettled: 1, abandoned: 1 });

    h.gated.release("a");
    await flush();

    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("counts a handler that settles in the same turn as a cancellation as settled", async () => {
    const h = harness();
    const cancel = new AbortController();
    const pending = h.call("a", cancel.signal);

    await h.gated.whenStarted(1);
    h.gated.release("a");
    cancel.abort();

    expect(codeOf(await pending)).toBe("cancelled");
    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("accounts for several abandoned handlers at once and releases them independently", async () => {
    const h = harness();

    await abandon(h, ["a", "b", "c"]);

    expect(h.ledger.counts()).toEqual({ unsettled: 3, abandoned: 3 });

    h.gated.release("b");
    await flush();

    expect(h.ledger.counts()).toEqual({ unsettled: 2, abandoned: 2 });

    h.gated.release("a");
    h.gated.release("c");
    await flush();

    expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("accounts for a late rejection without an unhandled rejection", async () => {
    const unhandled: string[] = [];

    const record = (): void => {
      unhandled.push("unhandledRejection");
    };

    process.on("unhandledRejection", record);

    try {
      const rejects = defineTool({
        name: "late_reject",
        description: "Rejects after its caller stopped waiting.",
        risk: "read",
        requiresConfirmation: false,
        idempotency: "none",
        timeoutMs: TIMEOUT_MS,
        inputSchema: z.strictObject({}),
        outputSchema: z.strictObject({}),
        failures: {},
        execute: async (_input, { signal }) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => setTimeout(() => reject(new Error("late")), 5));
          }),
      });

      const h = harness(3, [rejects]);

      const pending = h.execute(
        { id: "late", name: "late_reject", arguments: {} },
        new AbortController().signal,
      );

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(codeOf(await pending)).toBe("timed_out");
      expect(h.ledger.counts()).toEqual({ unsettled: 1, abandoned: 1 });

      await vi.advanceTimersByTimeAsync(5);
      await new Promise((resolve) => realSetImmediate(resolve));

      expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });
});

describe("executor ledger limit", () => {
  it("refuses the fourth call once three handlers are abandoned, without invoking a handler", async () => {
    const h = harness();

    await abandon(h, ["a", "b", "c"]);

    const refused = await h.call("d");

    expect(refused).toEqual({
      ok: false,
      error: {
        code: "overloaded",
        message: "Too many earlier tool calls are still running; retry later.",
      },
    });

    expect(h.gated.started).toEqual(["a", "b", "c"]);
    expect(h.ledger.counts()).toEqual({ unsettled: 3, abandoned: 3 });
  });

  it("logs a refusal as a warning with the abandoned count only, never the arguments", async () => {
    const h = harness();
    const active = h.call("active");

    await h.gated.whenStarted(1);

    // Three handlers abandoned by cancellation while a fourth is still being waited on, so the
    // abandoned count (3) differs from the unsettled count (4).
    for (const [index, label] of ["a", "b", "c"].entries()) {
      const cancel = new AbortController();
      const pending = h.call(label, cancel.signal);

      await h.gated.whenStarted(index + 2);
      cancel.abort();

      expect(codeOf(await pending)).toBe("cancelled");
    }

    expect(h.ledger.counts()).toEqual({ unsettled: 4, abandoned: 3 });

    await h.call("secret-label-value");

    const refusal = h.logger.entries.filter(({ fields }) => {
      const { outcome } = fields;

      return outcome === "overloaded";
    });

    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toMatchObject({
      level: "warn",
      message: "tool.failed",
      fields: { handlerInvoked: false, abandonedHandlers: 3, toolName: "gated" },
    });

    expect(JSON.stringify(h.logger.entries)).not.toContain("secret-label-value");

    h.gated.release("active");
    await active;
  });

  it("admits calls again the moment one abandoned handler settles", async () => {
    const h = harness();

    await abandon(h, ["a", "b", "c"]);

    expect(codeOf(await h.call("d"))).toBe("overloaded");

    h.gated.release("b");
    await flush();

    const next = h.call("e");

    await h.gated.whenStarted(4);
    h.gated.release("e");

    expect(codeOf(await next)).toBe("ok");
  });

  it("honours a configured limit", async () => {
    const h = harness(1);

    await abandon(h, ["a"]);

    expect(codeOf(await h.call("b"))).toBe("overloaded");
  });

  it("does not let active handlers count towards the limit", async () => {
    const h = harness();
    const active = ["a", "b", "c", "d", "e"].map((label) => h.call(label));

    await h.gated.whenStarted(5);

    expect(h.ledger.counts()).toEqual({ unsettled: 5, abandoned: 0 });

    for (const label of ["a", "b", "c", "d", "e"]) {
      h.gated.release(label);
    }

    expect((await Promise.all(active)).map(codeOf)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
  });

  it("can exceed the limit by the handlers that were active when it was reached", async () => {
    // The limit is checked when a call arrives, so calls already running are not stopped by it:
    // two abandoned handlers admit five more, and all seven can be abandoned. The bound on
    // active handlers belongs to whoever admits calls (the MCP in-flight cap, the sequential agent).
    const h = harness();

    await abandon(h, ["a", "b"]);

    const burst = ["c", "d", "e", "f", "g"].map((label) => h.call(label));

    await h.gated.whenStarted(7);
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect((await Promise.all(burst)).map(codeOf)).toEqual(Array(5).fill("timed_out"));
    expect(h.ledger.counts()).toEqual({ unsettled: 7, abandoned: 7 });
    expect(codeOf(await h.call("h"))).toBe("overloaded");
  });

  it("applies the default limit of three when no ledger is supplied", async () => {
    const gated = createGatedTool({ honorsSignal: false });

    const execute = createToolExecutor({
      registry: createToolRegistry([gated.tool]),
      clock: createFakeClock(),
      logger: createRecordingLogger(),
      maxResultBytes: 1_000,
    });

    for (const label of ["a", "b", "c"]) {
      const pending = execute(
        { id: label, name: "gated", arguments: { label } },
        new AbortController().signal,
      );

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(codeOf(await pending)).toBe("timed_out");
    }

    const refused = await execute(
      { id: "d", name: "gated", arguments: { label: "d" } },
      new AbortController().signal,
    );

    expect(codeOf(refused)).toBe("overloaded");
  });

  it("applies the policy before the limit: a confirmation-gated tool is still refused as such", async () => {
    const guarded = defineTool({
      name: "guarded",
      description: "Needs confirmation.",
      risk: "destructive",
      requiresConfirmation: true,
      idempotency: "none",
      timeoutMs: TIMEOUT_MS,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({}),
      failures: {},
      execute: async () => ({ ok: true, value: {} }),
    });

    const h = harness(1, [guarded]);

    await abandon(h, ["a"]);

    const result = await h.execute(
      { id: "g", name: "guarded", arguments: {} },
      new AbortController().signal,
    );

    expect(codeOf(result)).toBe("confirmation_required");
  });

  it("survives 60 timeout-and-settle cycles without drift, leaked timers, or a stuck limit", async () => {
    const h = harness(1);

    for (let cycle = 0; cycle < 60; cycle += 1) {
      const label = `cycle-${cycle}`;
      const pending = h.call(label);

      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(codeOf(await pending)).toBe("timed_out");
      expect(h.ledger.counts()).toEqual({ unsettled: 1, abandoned: 1 });

      h.gated.release(label);
      await flush();

      expect(h.ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    }

    expect(h.gated.started).toHaveLength(60);
  });
});

describe("executor ledger idle", () => {
  it("lets a shutdown wait for abandoned handlers to really settle", async () => {
    const h = harness();
    let idle = false;

    await abandon(h, ["a", "b"]);
    void h.ledger.idle().then(() => {
      idle = true;
    });

    h.gated.release("a");
    await flush();

    expect(idle).toBe(false);

    h.gated.release("b");
    await flush();

    expect(idle).toBe(true);
  });
});
