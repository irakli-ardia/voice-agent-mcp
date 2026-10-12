import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHandlerLedger } from "../../../../src/app/tools/handler-ledger.js";
import { createToolExecutor } from "../../../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../../../src/app/tools/tool-registry.js";
import { ok } from "../../../../src/domain/result.js";
import { defineTool } from "../../../../src/tools/tool-definition.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import { createRecordingLogger } from "../../../helpers/recording-logger.js";

/**
 * A handler is typed to return a promise, but the type is not a runtime guarantee. Whatever it
 * returns instead, the ledger entry must end: an entry that never settles would make every later
 * shutdown wait out its whole grace and report an incomplete shutdown.
 */
function executorWith(handler: () => object | number) {
  const base = defineTool({
    name: "odd_tool",
    description: "Test only.",
    risk: "read",
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: 100,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
    failures: {},
    execute: async () => ok({}),
  });

  // `JSON.parse` returns `any`, which is how a handler that breaks its type is built without a cast.
  const tool = { ...base, bindArguments: () => ok(() => JSON.parse(JSON.stringify(handler()))) };
  const ledger = createHandlerLedger({ maxAbandoned: 3 });

  const execute = createToolExecutor({
    registry: createToolRegistry([tool]),
    clock: createFakeClock(),
    logger: createRecordingLogger(),
    maxResultBytes: 1_000,
    handlerLedger: ledger,
  });

  return {
    ledger,
    run: () => execute({ id: "c1", name: "odd_tool", arguments: {} }, new AbortController().signal),
  };
}

describe("a handler that breaks its return type", () => {
  it("settles its ledger entry when it returns a plain value instead of a promise", async () => {
    const { ledger, run } = executorWith(() => ({ ok: true, value: {} }));
    const result = await run();

    expect(result.ok).toBe(true);
    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    await expect(ledger.idle()).resolves.toBeUndefined();
  });

  it("settles its ledger entry when it returns something that is not a result", async () => {
    const { ledger, run } = executorWith(() => 5);
    const result = await run();

    expect(result.ok).toBe(false);
    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });
});
