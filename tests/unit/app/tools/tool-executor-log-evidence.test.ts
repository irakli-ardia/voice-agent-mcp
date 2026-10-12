import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createToolExecutor } from "../../../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../../../src/app/tools/tool-registry.js";
import { ok } from "../../../../src/domain/result.js";
import { defineTool } from "../../../../src/tools/tool-definition.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import { createRecordingLogger } from "../../../helpers/recording-logger.js";

/** The log event is the only evidence of what a call did, so its facts are part of the contract. */
function executorFor(
  outputSchema: z.ZodType<{ text: string }, { text: string }>,
  execute: (clock: ReturnType<typeof createFakeClock>) => void,
  maxResultBytes = 1_000,
) {
  const clock = createFakeClock();
  const logger = createRecordingLogger();

  const tool = defineTool({
    name: "evidence_tool",
    description: "Test only.",
    risk: "read",
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: 1_000,
    inputSchema: z.strictObject({}),
    outputSchema,
    failures: {},
    execute: async () => {
      execute(clock);

      return ok({ text: "a result that is long enough to pass the small cap below" });
    },
  });

  const executor = createToolExecutor({
    registry: createToolRegistry([tool]),
    clock,
    logger,
    maxResultBytes,
  });

  return {
    clock,
    logger,
    run: () =>
      executor({ id: "c1", name: "evidence_tool", arguments: {} }, new AbortController().signal),
  };
}

describe("the outcome log event", () => {
  it("reports how long the call took, by the injected clock", async () => {
    const { clock, logger, run } = executorFor(z.strictObject({ text: z.string() }), (during) => {
      during.advance(250);
    });

    // The call starts well after the clock's zero, so a sum and a difference cannot agree.
    clock.advance(1_000);
    await run();

    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: "tool.completed",
        fields: expect.objectContaining({ durationMs: 250 }),
      }),
    );
  });

  it("reports how long a handler took when it finishes after the executor stopped waiting", async () => {
    const gate = Promise.withResolvers<void>();
    const clock = createFakeClock();
    const logger = createRecordingLogger();

    const tool = defineTool({
      name: "late_tool",
      description: "Test only.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs: 1_000,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({ text: z.string() }),
      failures: {},
      execute: async () => {
        await gate.promise;

        return ok({ text: "late" });
      },
    });

    const executor = createToolExecutor({
      registry: createToolRegistry([tool]),
      clock,
      logger,
      maxResultBytes: 1_000,
    });

    const cancel = new AbortController();

    clock.advance(1_000);

    const result = executor({ id: "c1", name: "late_tool", arguments: {} }, cancel.signal);

    cancel.abort();
    expect((await result).ok).toBe(false);

    clock.advance(300);
    gate.resolve();

    await vi.waitFor(() =>
      expect(logger.entries).toContainEqual(
        expect.objectContaining({
          message: "tool.settled_late",
          fields: expect.objectContaining({ durationMs: 300 }),
        }),
      ),
    );
  });

  it("says the handler ran when its result was too large to return", async () => {
    const { logger, run } = executorFor(z.strictObject({ text: z.string() }), () => {}, 20);
    const result = await run();

    expect(result.ok).toBe(false);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: "tool.failed",
        fields: expect.objectContaining({ outcome: "output_too_large", handlerInvoked: true }),
      }),
    );
  });

  it("says the handler ran when validating its output itself failed", async () => {
    const throwing = z.strictObject({ text: z.string() }).refine(() => {
      throw new Error("a schema defect");
    });

    const { logger, run } = executorFor(throwing, () => {});
    const result = await run();

    expect(result.ok).toBe(false);
    expect(logger.entries).toContainEqual(
      expect.objectContaining({
        message: "tool.failed",
        fields: expect.objectContaining({ outcome: "internal_error", handlerInvoked: true }),
      }),
    );
    expect(JSON.stringify(logger.entries)).not.toContain("a schema defect");
  });
});
