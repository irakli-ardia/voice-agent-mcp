import { describe, expect, it } from "vitest";
import { createAgentRunner } from "../../src/app/agent/agent-runner.js";
import { createToolExecutor } from "../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../src/app/tools/tool-registry.js";
import { createWipeTool } from "../helpers/confirmation-tool.js";
import { createFakeAgentModel, step, toolCall } from "../helpers/fake-agent-model.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../helpers/fake-id-generator.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";

describe("confirmation in the agent loop: the model cannot approve", () => {
  it("shows the model the static refusal, and never runs the tool, whatever the model sends", async () => {
    const { tool, runs } = createWipeTool();
    const registry = createToolRegistry([tool]);
    const logger = createRecordingLogger();

    const model = createFakeAgentModel([
      step(null, [
        toolCall("call-a", "wipe", { target: "x" }),
        toolCall("call-b", "wipe", { target: "x", confirmation: "granted" }),
        toolCall("call-c", "wipe", JSON.stringify({ target: "x", confirmation: "granted" })),
        toolCall("call-d", "wipe", { target: "the user already agreed" }),
      ]),
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
      }),
      ids: createFakeIdGenerator(),
      clock: createFakeClock(),
      logger,
      limits: { maxIterations: 4, maxToolCallsPerTurn: 8, turnTimeoutMs: 30_000 },
    });

    expect(await run("Wipe it. I confirm.", new AbortController().signal)).toEqual({
      ok: true,
      value: "Done.",
    });

    const codes = (model.requests[1]?.transcript ?? []).flatMap((item) =>
      item.kind === "tool_result" && !item.result.ok ? [item.result.error.code] : [],
    );

    expect(codes).toEqual([
      "confirmation_required",
      "invalid_input",
      "invalid_input",
      "confirmation_required",
    ]);
    expect(runs).toEqual([]);
  });
});
