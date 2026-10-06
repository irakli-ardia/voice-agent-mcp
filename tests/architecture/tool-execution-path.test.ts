import { describe, expect, it } from "vitest";
import { readTypeScriptFiles } from "../helpers/source-files.js";

/**
 * Nothing bypasses the executor: `bindArguments` is the only way to reach a handler, so only the
 * tool definition (which declares it) and the executor (the one caller) may name it.
 */
const ALLOWED = new Set(["src/tools/tool-definition.ts", "src/app/tools/tool-executor.ts"]);

describe("tool execution path", () => {
  it("lets only the executor reach tool handlers", () => {
    const offenders = readTypeScriptFiles("src")
      .filter((file) => /\bbindArguments\b/.test(file.text) && !ALLOWED.has(file.path))
      .map((file) => file.path);

    expect(offenders).toEqual([]);
  });

  it("still finds the executor's own call, so the scan cannot pass vacuously", () => {
    const executor = readTypeScriptFiles("src/app/tools").find(
      (file) => file.path === "src/app/tools/tool-executor.ts",
    );

    expect(executor?.text).toMatch(/\.bindArguments\(/);
  });
});
