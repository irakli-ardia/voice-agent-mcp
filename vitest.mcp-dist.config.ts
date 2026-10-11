import { defineConfig } from "vitest/config";

/**
 * The built-distribution gate: real child processes running the compiled JavaScript in `dist/`,
 * never the TypeScript sources. Run it through `npm run test:mcp-dist`, which builds first. It needs
 * no API key, no network, and no services; it is part of `npm run check` and of every CI job.
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/mcp-dist/**/*.test.ts"],
    globalSetup: ["tests/e2e/mcp-dist/require-fresh-build.ts"],
    allowOnly: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
