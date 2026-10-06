import type { Config } from "../../src/config/config.js";

/** A complete, quiet configuration with the documented defaults; tests override what they need. */
export function testConfig(overrides: Partial<Config> & Pick<Config, "dataDir">): Config {
  return {
    logLevel: "silent",
    maxToolResultBytes: 16_384,
    agent: {
      maxIterations: 8,
      maxToolCallsPerTurn: 16,
      maxInputTextChars: 4_000,
      turnTimeoutMs: 120_000,
    },
    openai: {
      model: "gpt-6-luna",
      timeoutMs: 60_000,
      maxRetries: 2,
      maxOutputTokens: 4_096,
      reasoningEffort: "none",
    },
    ...overrides,
  };
}
