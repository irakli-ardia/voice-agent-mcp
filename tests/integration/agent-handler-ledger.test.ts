import { describe, expect, it } from "vitest";
import { createAgentRunner } from "../../src/app/agent/agent-runner.js";
import { createHandlerLedger } from "../../src/app/tools/handler-ledger.js";
import { createToolExecutor } from "../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../src/app/tools/tool-registry.js";
import { createFakeAgentModel, step, toolCall } from "../helpers/fake-agent-model.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../helpers/fake-id-generator.js";
import { createGatedTool } from "../helpers/gated-tool.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";

describe("the handler ledger in the agent loop", () => {
  it("shows the model the static overloaded error once three tool calls were abandoned", async () => {
    const gated = createGatedTool({ honorsSignal: false, timeoutMs: 20 });
    const ledger = createHandlerLedger({ maxAbandoned: 3 });
    const registry = createToolRegistry([gated.tool]);
    const logger = createRecordingLogger();

    const model = createFakeAgentModel([
      step(
        null,
        ["a", "b", "c", "d"].map((label) => toolCall(`call-${label}`, "gated", { label })),
      ),
      step("Done."),
    ]);

    const run = createAgentRunner({
      model,
      registry,
      executeTool: createToolExecutor({
        registry,
        clock: createFakeClock(),
        logger,
        maxResultBytes: 16_384,
        handlerLedger: ledger,
      }),
      ids: createFakeIdGenerator(),
      clock: createFakeClock(),
      logger,
      limits: { maxIterations: 4, maxToolCallsPerTurn: 8, turnTimeoutMs: 30_000 },
    });

    expect(await run("Use the tool four times.", new AbortController().signal)).toEqual({
      ok: true,
      value: "Done.",
    });

    const codes = (model.requests[1]?.transcript ?? []).flatMap((item) =>
      item.kind === "tool_result" && !item.result.ok ? [item.result.error.code] : [],
    );

    expect(codes).toEqual(["timed_out", "timed_out", "timed_out", "overloaded"]);
    expect(gated.started).toEqual(["a", "b", "c"]);
    expect(ledger.counts()).toEqual({ unsettled: 3, abandoned: 3 });

    for (const label of ["a", "b", "c"]) {
      gated.release(label);
    }

    await ledger.idle();

    expect(ledger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });
});
