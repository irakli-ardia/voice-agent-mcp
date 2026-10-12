import { z } from "zod";
import { ok } from "../../src/domain/result.js";
import { defineTool, type ToolDefinition } from "../../src/tools/tool-definition.js";
import { untilAborted } from "./until-aborted.js";

export interface GatedToolOptions {
  readonly name?: string;
  /** True: an abort ends a held call. False: the call ignores its signal and still finishes. */
  readonly honorsSignal?: boolean;
  /** The tool's deadline in milliseconds (default 10 000). */
  readonly timeoutMs?: number;
}

export interface GatedTool {
  readonly tool: ToolDefinition;
  /** Labels of calls that reached the handler, in order. */
  readonly started: readonly string[];
  /** Labels of calls whose handler ran to its end. */
  readonly finished: readonly string[];
  /** The signal each started call received, by label. */
  readonly signals: ReadonlyMap<string, AbortSignal>;
  /** Calls inside the handler right now, and the most there have ever been at once. */
  active(): number;
  peak(): number;
  /** Resolves once `count` calls have reached the handler. */
  whenStarted(count: number): Promise<void>;
  /** Lets the held call with this label finish; may be called before the call starts. */
  release(label: string): void;
}

/**
 * A read tool whose handler waits until the test releases its label: the way tests hold calls
 * in flight without timers. The handler stays held after an abort when `honorsSignal` is false,
 * which models a write that completes after the caller stopped waiting.
 */
export function createGatedTool(options: GatedToolOptions = {}): GatedTool {
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const started: string[] = [];
  const finished: string[] = [];
  const signals = new Map<string, AbortSignal>();
  let active = 0;
  let peak = 0;
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];

  const gateFor = (label: string): PromiseWithResolvers<void> => {
    const existing = gates.get(label);

    if (existing !== undefined) {
      return existing;
    }

    const created = Promise.withResolvers<void>();

    gates.set(label, created);

    return created;
  };

  const tool = defineTool({
    name: options.name ?? "gated",
    description: "Waits until released.",
    risk: "read",
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: options.timeoutMs ?? 10_000,
    inputSchema: z.strictObject({ label: z.string().max(32).describe("Names the call.") }),
    outputSchema: z.strictObject({ label: z.string() }),
    failures: {},
    execute: async ({ label }, { signal }) => {
      const gate = gateFor(label);

      started.push(label);
      signals.set(label, signal);
      active += 1;
      peak = Math.max(peak, active);

      for (const waiter of waiters) {
        if (started.length >= waiter.count) {
          waiter.resolve();
        }
      }

      try {
        await (options.honorsSignal === false
          ? gate.promise
          : Promise.race([gate.promise, untilAborted(signal)]));
        finished.push(label);
      } finally {
        active -= 1;
      }

      return ok({ label });
    },
  });

  return {
    tool,
    started,
    finished,
    signals,
    active: (): number => active,
    peak: (): number => peak,
    whenStarted: async (count: number): Promise<void> => {
      if (started.length >= count) {
        return;
      }

      await new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
    release: (label: string): void => gateFor(label).resolve(),
  };
}
