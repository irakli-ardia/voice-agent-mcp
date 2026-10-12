// Test-only script, run in a child process by tests/e2e/mcp-dist/mcp-dist-confirmation.test.ts.
// It loads the executor, registry, tool definition and confirmation grant from one tree ("src",
// through the tsx loader, or "dist", plain node) and prints what the confirmation gate did.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const tree = process.argv[2];

if (tree !== "src" && tree !== "dist") {
  throw new Error('The first argument must be "src" or "dist".');
}

const root = join(import.meta.dirname, "..", "..", tree);

const load = async (relative) => import(pathToFileURL(join(root, relative)).href);

const { ConfirmationGrant } = await load("domain/confirmation-grant.js");

const { createToolExecutor } = await load("app/tools/tool-executor.js");

const { createToolRegistry } = await load("app/tools/tool-registry.js");

const { defineTool } = await load("tools/tool-definition.js");

const { ok } = await load("domain/result.js");

let runs = 0;

const tool = defineTool({
  name: "wipe",
  description: "Test only.",
  risk: "destructive",
  requiresConfirmation: true,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => {
    runs += 1;

    return ok({});
  },
});

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger;
  },
};

const execute = createToolExecutor({
  registry: createToolRegistry([tool]),
  clock: { now: () => new Date(0), monotonicNow: () => 0 },
  logger,
  maxResultBytes: 1_000,
});

const signal = new AbortController().signal;

const code = (result) => (result.ok ? "ok" : result.error.code);

const base = { id: "call-1", name: "wipe", arguments: {} };

const grant = new ConfirmationGrant({ toolName: "wipe", toolCallId: "call-1" });

const report = {
  withoutGrant: code(await execute(base, signal)),
  lookalike: code(
    await execute({ ...base, confirmation: { covers: () => true, consume: () => true } }, signal),
  ),
  throughJson: code(
    await execute({ ...base, confirmation: JSON.parse(JSON.stringify(grant)) }, signal),
  ),
  string: code(await execute({ ...base, confirmation: "granted" }, signal)),
  runsBeforeGrant: runs,
  withGrant: code(await execute({ ...base, confirmation: grant }, signal)),
  repeat: code(await execute({ ...base, confirmation: grant }, signal)),
  otherCall: code(
    await execute(
      {
        ...base,
        id: "call-2",
        confirmation: new ConfirmationGrant({ toolName: "wipe", toolCallId: "call-1" }),
      },
      signal,
    ),
  ),
  runs,
};

process.stdout.write(`${JSON.stringify(report)}
`);
