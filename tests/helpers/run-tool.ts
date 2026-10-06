import { createToolExecutor } from "../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../src/app/tools/tool-registry.js";
import type { JsonObject } from "../../src/domain/json-value.js";
import type { Result } from "../../src/domain/result.js";
import type { ToolExecutionError } from "../../src/domain/tool-execution-error.js";
import type { Clock } from "../../src/ports/clock.js";
import type { ToolCall, ToolDefinition } from "../../src/tools/tool-definition.js";
import { createFakeClock } from "./fake-clock.js";
import { createRecordingLogger } from "./recording-logger.js";

/** Runs one call to `tool` through the real executor, as every production caller does. */
export async function runTool(
  tool: ToolDefinition,
  call: Pick<ToolCall, "arguments">,
  clock: Clock = createFakeClock(),
): Promise<Result<JsonObject, ToolExecutionError>> {
  const execute = createToolExecutor({
    registry: createToolRegistry([tool]),
    clock,
    logger: createRecordingLogger(),
    maxResultBytes: 16_384,
  });

  return execute({ id: "call-1", name: tool.name, ...call }, new AbortController().signal);
}
