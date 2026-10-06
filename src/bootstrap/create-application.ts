import { createPinoLogger } from "../adapters/logging/pino-logger.js";
import { systemClock } from "../adapters/system/system-clock.js";
import { createToolExecutor, type ToolExecutor } from "../app/tools/tool-executor.js";
import { createToolRegistry, type ToolRegistry } from "../app/tools/tool-registry.js";
import type { Config } from "../config/config.js";
import type { Logger } from "../ports/logger.js";
import { calculateTool } from "../tools/calculate/calculate-tool.js";
import { getCurrentTimeTool } from "../tools/get-current-time/get-current-time-tool.js";

export interface Application {
  readonly config: Config;
  readonly logger: Logger;
  /** The canonical tool registry: the one list every protocol adapter derives from. */
  readonly tools: ToolRegistry;
  /** The one path to run a tool. */
  readonly executeTool: ToolExecutor;
}

/** Composition root: the one place concrete adapters are chosen and wired to ports. */
export function createApplication(config: Config): Application {
  const logger = createPinoLogger({ level: config.logLevel });
  const tools = createToolRegistry([getCurrentTimeTool, calculateTool]);

  return {
    config,
    logger,
    tools,
    executeTool: createToolExecutor({
      registry: tools,
      clock: systemClock,
      logger,
      maxResultBytes: config.maxToolResultBytes,
    }),
  };
}
