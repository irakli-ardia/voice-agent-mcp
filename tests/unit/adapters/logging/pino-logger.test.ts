import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createPinoLogger } from "../../../../src/adapters/logging/pino-logger.js";
import type { LogLevel } from "../../../../src/config/config.js";
import type { Logger } from "../../../../src/ports/logger.js";

const logLineSchema = z.looseObject({ level: z.number(), msg: z.string() });

type LogLine = z.output<typeof logLineSchema>;

interface CapturedLogger {
  readonly logger: Logger;
  readonly lines: () => LogLine[];
}

function capture(level: LogLevel): CapturedLogger {
  const chunks: string[] = [];

  const logger = createPinoLogger({
    level,
    destination: {
      write: (chunk: string): void => {
        chunks.push(chunk);
      },
    },
  });

  return {
    logger,
    lines: (): LogLine[] =>
      chunks
        .join("")
        .split("\n")
        .flatMap((line) => (line.length > 0 ? [logLineSchema.parse(JSON.parse(line))] : [])),
  };
}

describe("createPinoLogger", () => {
  it("writes structured JSON with the message and fields", () => {
    const { logger, lines } = capture("info");
    logger.info("turn.started", { turnId: "t-1" });
    expect(lines()).toEqual([expect.objectContaining({ msg: "turn.started", turnId: "t-1" })]);
  });

  it("emits every level at or above the configured one", () => {
    const { logger, lines } = capture("debug");
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lines()).toEqual([
      expect.objectContaining({ msg: "a", level: 20 }),
      expect.objectContaining({ msg: "b", level: 30 }),
      expect.objectContaining({ msg: "c", level: 40 }),
      expect.objectContaining({ msg: "d", level: 50 }),
    ]);
  });

  it("drops entries below the configured level", () => {
    const { logger, lines } = capture("warn");
    logger.info("ignored");
    expect(lines()).toEqual([]);
  });

  it("carries child bindings into every entry", () => {
    const { logger, lines } = capture("info");
    logger.child({ turnId: "t-2" }).warn("tool.timed_out", { toolName: "calculate" });
    expect(lines()).toEqual([
      expect.objectContaining({ msg: "tool.timed_out", turnId: "t-2", toolName: "calculate" }),
    ]);
  });

  it("redacts secret-bearing fields", () => {
    const { logger, lines } = capture("info");
    logger.error("provider.failed", {
      apiKey: "sk-top-level",
      request: { authorization: "Bearer sk-nested" },
    });
    const output = JSON.stringify(lines());
    expect(output).not.toContain("sk-top-level");
    expect(output).not.toContain("sk-nested");
    expect(output).toContain("[redacted]");
  });
});
