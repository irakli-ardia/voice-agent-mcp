import { defineConfig } from "vitest/config";

/**
 * Opt-in live suite against the real OpenAI API: needs OPENAI_API_KEY, the network, and spends
 * API credits. Never part of `npm test`, `npm run check`, or CI.
 */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    allowOnly: false,
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
