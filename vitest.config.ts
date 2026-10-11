import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Live OpenAI tests spend API credits; they run only through `npm run test:openai`. The
    // built-distribution tests need `dist/`; they run through `npm run test:mcp-dist`.
    exclude: ["tests/live/**", "tests/e2e/**", "node_modules/**"],
    allowOnly: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The bin only hands process I/O to runCli (tested in tests/unit/entrypoints).
      exclude: ["src/entrypoints/voice-agent.ts"],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
});
