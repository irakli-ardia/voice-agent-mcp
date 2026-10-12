import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * The confirmation gate in the compiled code: the grant's private state and the executor's
 * `instanceof` check must survive compilation. A child process loads the compiled modules by path
 * (`tests/helpers/confirmation-check.mjs`), so this can never run against the TypeScript sources.
 */
const SCRIPT = join(import.meta.dirname, "..", "..", "helpers", "confirmation-check.mjs");

const report = z.strictObject({
  withoutGrant: z.string(),
  lookalike: z.string(),
  throughJson: z.string(),
  string: z.string(),
  runsBeforeGrant: z.number(),
  withGrant: z.string(),
  repeat: z.string(),
  otherCall: z.string(),
  runs: z.number(),
});

describe("the compiled confirmation gate", () => {
  it("refuses everything but a host-issued grant for the call, once", async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [SCRIPT, "dist"]);

    expect(report.parse(JSON.parse(stdout))).toEqual({
      withoutGrant: "confirmation_required",
      lookalike: "confirmation_required",
      throughJson: "confirmation_required",
      string: "confirmation_required",
      runsBeforeGrant: 0,
      withGrant: "ok",
      repeat: "confirmation_required",
      otherCall: "confirmation_required",
      runs: 1,
    });
  });
});
