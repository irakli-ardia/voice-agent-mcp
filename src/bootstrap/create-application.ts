import { createPinoLogger } from "../adapters/logging/pino-logger.js";
import type { Config } from "../config/config.js";
import type { Logger } from "../ports/logger.js";

export interface Application {
  readonly config: Config;
  readonly logger: Logger;
}

/** Composition root: the one place concrete adapters are chosen and wired to ports. */
export function createApplication(config: Config): Application {
  return {
    config,
    logger: createPinoLogger({ level: config.logLevel }),
  };
}
