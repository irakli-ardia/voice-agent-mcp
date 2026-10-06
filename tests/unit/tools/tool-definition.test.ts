import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { err, ok } from "../../../src/domain/result.js";
import { defineTool, type ToolCall, type ToolContext } from "../../../src/tools/tool-definition.js";
import { createFakeClock } from "../../helpers/fake-clock.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function context(): ToolContext {
  return { signal: new AbortController().signal, clock: createFakeClock() };
}

const CALL: Omit<ToolCall, "arguments"> = { id: "call-1", name: "divide" };

const received: unknown[] = [];

const divideTool = defineTool({
  name: "divide",
  description: "Divides a by b.",
  risk: "read",
  requiresConfirmation: false,
  timeoutMs: 1_000,
  inputSchema: z.strictObject({ a: z.number(), b: z.number() }),
  outputSchema: z.strictObject({ quotient: z.number() }),
  failures: { division_by_zero: "Division by zero is undefined." },
  execute: async (input) => {
    expectTypeOf(input).toEqualTypeOf<{ a: number; b: number }>();
    received.push(input);

    return input.b === 0 ? err("division_by_zero") : ok({ quotient: input.a / input.b });
  },
});

describe("defineTool", () => {
  it("keeps the metadata and schemas of the spec", () => {
    expect(divideTool).toMatchObject({
      name: "divide",
      description: "Divides a by b.",
      risk: "read",
      requiresConfirmation: false,
      timeoutMs: 1_000,
      failures: [{ reason: "division_by_zero", message: "Division by zero is undefined." }],
    });
    expect(divideTool.inputSchema.safeParse({ a: 1, b: 2 }).success).toBe(true);
    expect(divideTool.outputSchema.safeParse({ quotient: 1 }).success).toBe(true);
  });

  it("rejects arguments that fail the input schema without binding a handler", () => {
    received.length = 0;
    const bound = divideTool.bindArguments({ ...CALL, arguments: { a: "1", b: 2, extra: true } });
    expect(bound.ok).toBe(false);

    if (bound.ok) {
      return;
    }

    expect(bound.error.map((issue) => issue.code).sort()).toEqual([
      "invalid_type",
      "unrecognized_keys",
    ]);
    expect(received).toEqual([]);
  });

  it("binds valid arguments and hands the parsed input to the handler", async () => {
    received.length = 0;
    const bound = divideTool.bindArguments({ ...CALL, arguments: { a: 6, b: 3 } });
    expect(bound.ok).toBe(true);

    if (!bound.ok) {
      return;
    }

    expect(received).toEqual([]);
    expect(await bound.value(context())).toEqual({ ok: true, value: { quotient: 2 } });
    expect(received).toEqual([{ a: 6, b: 3 }]);
  });

  it("turns a declared failure reason into its static message", async () => {
    const bound = divideTool.bindArguments({ ...CALL, arguments: { a: 1, b: 0 } });

    if (!bound.ok) {
      throw new Error("expected valid arguments");
    }

    expect(await bound.value(context())).toEqual({
      ok: false,
      error: { reason: "division_by_zero", message: "Division by zero is undefined." },
    });
  });
});

/**
 * Compile-time contract, checked by running the TypeScript compiler on small fixtures that use the
 * real `defineTool`. The control fixture must compile; every other fixture must fail. This proves
 * the negative cases without any TypeScript suppression comment.
 */
const FIXTURE_IMPORTS = [
  'import { z } from "zod";',
  'import { err, ok, type Result } from "@src/domain/result.js";',
  'import { defineTool } from "@src/tools/tool-definition.js";',
].join("\n");

const BASE_SPEC =
  'name: "t", description: "d", risk: "read", requiresConfirmation: false, timeoutMs: 1,';

const FIXTURES: readonly { readonly name: string; readonly body: string }[] = [
  {
    name: "control",
    body: `export const withFailures = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({ a: z.number() }),
  outputSchema: z.strictObject({ r: z.number() }),
  failures: { bad: "Bad." },
  execute: async ({ a }) => (a > 0 ? ok({ r: a }) : err("bad")),
});
export const withoutFailures = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({ zone: z.string().nullable() }),
  outputSchema: z.strictObject({ zone: z.string() }),
  failures: {},
  execute: async ({ zone }, context) => ok({ zone: zone ?? context.clock.now().toISOString() }),
});
export const destructive = defineTool({ name: "d", description: "d", risk: "destructive",
  requiresConfirmation: true, timeoutMs: 1,
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: {},
  execute: async () => ok({}),
});`,
  },
  {
    name: "caught-error-message-as-reason",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}),
  failures: { storage_unavailable: "Storage is unavailable." },
  execute: async () => {
    try { return ok({}); } catch (error) { return err(error instanceof Error ? error.message : "x"); }
  },
});`,
  },
  {
    name: "widened-string-reason",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: { a: "A." },
  execute: async () => { const reason: string = "a"; return err(reason); },
});`,
  },
  {
    name: "string-keyed-failures-table",
    body: `const FAILURES: Record<string, string> = { a: "A." };
export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: FAILURES,
  execute: async () => { const reason: string = "a"; return err(reason); },
});`,
  },
  {
    name: "failures-table-from-entries",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}),
  failures: Object.fromEntries([["a", "A."]]),
  execute: async () => { const reason: string = "a"; return err(reason); },
});`,
  },
  {
    name: "explicit-string-failure-type",
    body: `export const t = defineTool<z.ZodObject<{}, z.core.$strict>, Record<never, never>, string>({
  ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: { a: "A." },
  execute: async () => { const reason: string = "a"; return err(reason); },
});`,
  },
  {
    name: "template-pattern-failures-table",
    body: `const FAILURES: { readonly [reason: \`db_\${string}\`]: string } = {};
export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: FAILURES,
  execute: async (): Promise<Result<Record<never, never>, \`db_\${string}\`>> => {
    const detail: string = "x";
    return err(\`db_\${detail}\` as const);
  },
});`,
  },
  {
    name: "undeclared-reason",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: { a: "A." },
  execute: async () => err("b"),
});`,
  },
  {
    name: "reason-from-a-tool-without-failures",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: {},
  execute: async () => err("anything"),
});`,
  },
  {
    name: "destructive-without-confirmation",
    body: `export const t = defineTool({ name: "t", description: "d", risk: "destructive",
  requiresConfirmation: false, timeoutMs: 1,
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({}), failures: {},
  execute: async () => ok({}),
});`,
  },
  {
    name: "handler-output-mismatch",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({ n: z.number() }), failures: {},
  execute: async () => ok({ n: "1" }),
});`,
  },
  {
    name: "non-json-output",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({ at: z.date() }), failures: {},
  execute: async () => ok({ at: new Date() }),
});`,
  },
  {
    name: "non-object-output",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}), outputSchema: z.number(), failures: {},
  execute: async () => ok(1),
});`,
  },
  {
    name: "transform-in-output-schema",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ n: z.string().transform((text) => text.length) }),
  failures: {}, execute: async () => ok({ n: 1 }),
});`,
  },
  {
    name: "non-object-input",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.string(), outputSchema: z.strictObject({}), failures: {},
  execute: async () => ok({}),
});`,
  },
  {
    name: "record-input",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.record(z.string(), z.number()), outputSchema: z.strictObject({}), failures: {},
  execute: async () => ok({}),
});`,
  },
  {
    name: "handler-reads-undeclared-input",
    body: `export const t = defineTool({ ${BASE_SPEC}
  inputSchema: z.strictObject({ a: z.number() }), outputSchema: z.strictObject({ n: z.number() }),
  failures: {}, execute: async (input) => ok({ n: input.missing }),
});`,
  },
];

function forwardSlashes(path: string): string {
  return path.replaceAll("\\", "/");
}

interface CompileReport {
  readonly errorCounts: ReadonlyMap<string, number>;
  readonly output: string;
}

/** Compiles every fixture in one compiler run and counts the errors reported per fixture. */
function compileFixtures(directory: string): CompileReport {
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(directory, "node_modules"), "junction");
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: forwardSlashes(join(REPO_ROOT, "tsconfig.base.json")),
      compilerOptions: {
        noEmit: true,
        // Fixtures share one import list; an unused import must not count as a contract failure.
        noUnusedLocals: false,
        paths: { "@src/*": [`${forwardSlashes(join(REPO_ROOT, "src"))}/*`] },
      },
      include: ["*.ts"],
    }),
  );

  for (const fixture of FIXTURES) {
    writeFileSync(join(directory, `${fixture.name}.ts`), `${FIXTURE_IMPORTS}\n${fixture.body}\n`);
  }

  const result = spawnSync(
    process.execPath,
    [join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", directory],
    { cwd: directory, encoding: "utf8" },
  );

  const errorFiles = [...result.stdout.matchAll(/^([\w-]+)\.ts\(\d+,\d+\): error TS/gm)].flatMap(
    (match) => match[1] ?? [],
  );

  const errorCounts = new Map(
    FIXTURES.map((fixture) => [
      fixture.name,
      errorFiles.filter((file) => file === fixture.name).length,
    ]),
  );

  return { errorCounts, output: result.stdout };
}

describe("defineTool compile-time contract", () => {
  let directory = "";
  let report: CompileReport = { errorCounts: new Map(), output: "" };

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "tool-definition-types-"));
    report = compileFixtures(directory);
  }, 60_000);

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("compiles the control fixture without errors", () => {
    expect(report.errorCounts.get("control")).toBe(0);
  });

  it("fails only on type errors, never on syntax, module resolution, or configuration", () => {
    expect(report.output).not.toMatch(/error TS(1\d{3}|2307|2792|5\d{3}|6\d{3})\b/);
  });

  it.each(FIXTURES.flatMap((fixture) => (fixture.name === "control" ? [] : [fixture.name])))(
    "rejects %s at compile time",
    (name) => {
      expect(report.errorCounts.get(name)).toBeGreaterThan(0);
    },
  );
});
