import { join } from "node:path";
import { createBoundedStderr } from "../adapters/logging/bounded-stderr.js";
import { createPinoLogger, type PinoLoggerOptions } from "../adapters/logging/pino-logger.js";
import { createFileNoteStore } from "../adapters/persistence/file-note-store.js";
import { systemClock } from "../adapters/system/system-clock.js";
import { createHandlerLedger, type HandlerLedger } from "../app/tools/handler-ledger.js";
import { createToolExecutor, type ToolExecutor } from "../app/tools/tool-executor.js";
import { createToolRegistry, type ToolRegistry } from "../app/tools/tool-registry.js";
import type { Config } from "../config/config.js";
import type { Logger } from "../ports/logger.js";
import { calculateTool } from "../tools/calculate/calculate-tool.js";
import { defineCreateNoteTool } from "../tools/create-note/create-note-tool.js";
import { getCurrentTimeTool } from "../tools/get-current-time/get-current-time-tool.js";
import { defineReadNoteTool } from "../tools/read-note/read-note-tool.js";

export interface Application {
  readonly config: Config;
  readonly logger: Logger;
  /** The canonical tool registry: the one list every protocol adapter derives from. */
  readonly tools: ToolRegistry;
  /** The one path to run a tool. */
  readonly executeTool: ToolExecutor;
  /** Every invoked handler until it settles; a shutdown can wait on `idle()`. */
  readonly handlerLedger: HandlerLedger;
  /**
   * Gives logs that are still queued up to `timeoutMs` to reach stderr, at an orderly end. Resolves
   * at once for synchronous logging. Never rejects; what is not written by then is lost.
   */
  readonly flushLogs: (timeoutMs: number) => Promise<void>;
}

export interface ApplicationOptions {
  /**
   * `synchronous` (default): logs are written to stderr before the call returns, in order, which
   * suits a terminal and a short command. `non-blocking`: logs are queued in a bounded buffer and
   * written in the background, and dropped when stderr stalls; for the MCP server, whose host may
   * stop reading stderr.
   */
  readonly stderr?: "synchronous" | "non-blocking";
}

/**
 * Composition root: the one place concrete adapters are chosen and wired to ports. Performs no I/O:
 * the note store creates its directory on the first write.
 */
export function createApplication(config: Config, options: ApplicationOptions = {}): Application {
  const stderr = options.stderr === "non-blocking" ? createBoundedStderr() : undefined;

  const loggerOptions: PinoLoggerOptions =
    stderr === undefined
      ? { level: config.logLevel }
      : { level: config.logLevel, destination: stderr };

  const logger = createPinoLogger(loggerOptions);

  const notes = createFileNoteStore({
    directory: join(config.dataDir, "notes"),
    slotDirectory: join(config.dataDir, "note-slots"),
    maxNotes: config.maxNotes,
    logger,
  });

  const handlerLedger = createHandlerLedger({ maxAbandoned: config.maxAbandonedToolHandlers });

  const tools = createToolRegistry([
    getCurrentTimeTool,
    calculateTool,
    defineCreateNoteTool(notes),
    defineReadNoteTool(notes),
  ]);

  return {
    config,
    logger,
    tools,
    handlerLedger,
    flushLogs: async (timeoutMs: number): Promise<void> => stderr?.flush(timeoutMs),
    executeTool: createToolExecutor({
      registry: tools,
      clock: systemClock,
      logger,
      maxResultBytes: config.maxToolResultBytes,
      handlerLedger,
    }),
  };
}
