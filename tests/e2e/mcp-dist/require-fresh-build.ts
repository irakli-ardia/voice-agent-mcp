import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function newestModification(directory: string): number {
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .reduce((newest, name) => Math.max(newest, statSync(join(directory, name)).mtimeMs), 0);
}

/**
 * Refuses to run against a missing or stale `dist`, so these tests can never silently exercise an
 * old build (or, by a mistake in a helper, the TypeScript sources). `npm run test:mcp-dist` builds
 * first; this is the guard for anyone who runs Vitest with this config directly.
 */
export default function requireFreshBuild(): void {
  const entry = join(REPO_ROOT, "dist", "entrypoints", "voice-agent.js");

  if (!existsSync(entry)) {
    throw new Error("dist/ is missing: run `npm run build` (or `npm run test:mcp-dist`) first.");
  }

  if (statSync(entry).mtimeMs < newestModification(join(REPO_ROOT, "src"))) {
    throw new Error(
      "dist/ is older than src/: run `npm run build` (or `npm run test:mcp-dist`) first.",
    );
  }
}
