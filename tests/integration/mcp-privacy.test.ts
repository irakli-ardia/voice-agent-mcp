import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DestinationStream } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPinoLogger } from "../../src/adapters/logging/pino-logger.js";
import { createFileNoteStore } from "../../src/adapters/persistence/file-note-store.js";
import { ok } from "../../src/domain/result.js";
import type { Logger } from "../../src/ports/logger.js";
import { calculateTool } from "../../src/tools/calculate/calculate-tool.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { defineTool } from "../../src/tools/tool-definition.js";
import { createCommitGate } from "../helpers/commit-gate.js";
import { createFakeNoteStore } from "../helpers/fake-note-store.js";
import { buildMcpServer, connectClient } from "../helpers/mcp-harness.js";
import { connectRawMcp } from "../helpers/mcp-raw-peer.js";
import { untilAborted } from "../helpers/until-aborted.js";

const TEXT = "SENTINEL-NOTE-TEXT-3f9a7c";

const KEY = "SENTINEL-KEY-8e21d4-abcd";

const DIRECTORY = "SENTINEL-DIR-5b6e91";

const ARGUMENT = "SENTINEL-ARG-77aa31";

const KEY_NAME = "SENTINEL-PROPERTY-12bc40";

const OUTPUT = "SENTINEL-OUTPUT-09ef82";

const THROWN = "SENTINEL-THROWN-c4d1b6";

const LATE_THROWN = "SENTINEL-LATE-THROWN-a7e358";

/** Every value above that must stay out of logs and responses, except where a test says otherwise. */
const ALL_SENTINELS = [TEXT, KEY, DIRECTORY, ARGUMENT, KEY_NAME, OUTPUT, THROWN, LATE_THROWN];

/** The real pino logger writing into memory: what would reach stderr, serialised as it would be. */
interface CapturedLogger {
  readonly logger: Logger;
  text(): string;
}

function capturedLogger(): CapturedLogger {
  const lines: string[] = [];

  const destination: DestinationStream = {
    write: (line: string): void => {
      lines.push(line);
    },
  };

  return { logger: createPinoLogger({ level: "trace", destination }), text: () => lines.join("") };
}

function expectNone(haystack: string, needles: readonly string[]): void {
  for (const needle of needles) {
    expect(haystack).not.toContain(needle);
  }
}

const throwing = defineTool({
  name: "throwing",
  description: "Throws an error that carries a secret.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => {
    throw new Error(`database down: ${THROWN}`);
  },
});

const throwingNonError = defineTool({
  name: "throwing_non_error",
  description: "Rejects with a plain object that carries a secret.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async () => Promise.reject({ token: THROWN }),
});

const oversized = defineTool({
  name: "oversized",
  description: "Returns far more than the result limit.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ t: z.string() }),
  failures: {},
  execute: async () => ok({ t: OUTPUT.repeat(50) }),
});

const invalidOutput = defineTool({
  name: "invalid_output",
  description: "Returns a value its own schema rejects.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 1_000,
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ t: z.string().max(5) }),
  failures: {},
  execute: async () => ok({ t: OUTPUT }),
});

const hanging = defineTool({
  name: "hanging",
  description: "Outlives its deadline.",
  risk: "read",
  requiresConfirmation: false,
  idempotency: "none",
  timeoutMs: 20,
  inputSchema: z.strictObject({ label: z.string().max(64).describe("A label.") }),
  outputSchema: z.strictObject({}),
  failures: {},
  execute: async (_input, { signal }) => untilAborted(signal),
});

describe("privacy of logs and responses", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  async function sentinelDirectory(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), `${DIRECTORY}-`));

    directories.push(dir);

    return dir;
  }

  it("normal calls: note text, key, and storage path stay out of the logs", async () => {
    const { logger, text } = capturedLogger();

    const store = createFileNoteStore({
      directory: join(await sentinelDirectory(), "notes"),
      logger,
    });

    const server = buildMcpServer({ tools: [defineCreateNoteTool(store)] }, logger);
    const { client, close } = await connectClient(server);

    const created = await client.callTool({
      name: "create_note",
      arguments: { text: TEXT, idempotencyKey: KEY },
    });

    expect(created.isError).toBeUndefined();
    expect(text()).toContain("tool.completed");
    expectNone(text(), ALL_SENTINELS);
    expectNone(JSON.stringify(created), [TEXT, KEY, DIRECTORY]);
    await close();
  });

  it("a storage failure: the response is static and neither it nor the logs show the path", async () => {
    const { logger, text } = capturedLogger();
    const root = await sentinelDirectory();

    // A file where the notes directory must go makes every create fail with a system error.
    await writeFile(join(root, "notes"), "not a directory");

    const store = createFileNoteStore({ directory: join(root, "notes"), logger });
    const server = buildMcpServer({ tools: [defineCreateNoteTool(store)] }, logger);
    const { client, close } = await connectClient(server);

    const failed = await client.callTool({
      name: "create_note",
      arguments: { text: TEXT, idempotencyKey: KEY },
    });

    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain("execution_failed: The note store is unavailable");
    expect(text()).toContain("note_store.unavailable");
    expectNone(text(), ALL_SENTINELS);
    expectNone(JSON.stringify(failed), [TEXT, KEY, DIRECTORY, root]);
    await close();
  });

  it("malformed input: neither the rejected values nor the unknown property name are echoed", async () => {
    const { logger, text } = capturedLogger();

    const { client, close } = await connectClient(
      buildMcpServer({ tools: [calculateTool] }, logger),
    );

    const rejected = await client.callTool({
      name: "calculate",
      arguments: { operation: ARGUMENT, a: ARGUMENT, b: 1, [KEY_NAME]: ARGUMENT },
    });

    expect(rejected.isError).toBe(true);
    expect(text()).toContain("tool.failed");
    expectNone(text(), ALL_SENTINELS);
    expectNone(JSON.stringify(rejected), ALL_SENTINELS);
    await close();
  });

  it("oversized output: the response and the logs carry its size, never its content", async () => {
    const { logger, text } = capturedLogger();

    const { client, close } = await connectClient(
      buildMcpServer({ tools: [oversized], maxResultBytes: 100 }, logger),
    );

    const refused = await client.callTool({ name: "oversized", arguments: {} });

    expect(JSON.stringify(refused)).toContain("output_too_large");
    expect(text()).toContain("resultBytes");
    expectNone(text(), ALL_SENTINELS);
    expectNone(JSON.stringify(refused), ALL_SENTINELS);
    await close();
  });

  it("an output that fails its schema: only paths and codes are logged, never the value", async () => {
    const { logger, text } = capturedLogger();

    const { client, close } = await connectClient(
      buildMcpServer({ tools: [invalidOutput] }, logger),
    );

    const refused = await client.callTool({ name: "invalid_output", arguments: {} });

    expect(JSON.stringify(refused)).toContain("invalid_output");
    expect(text()).toContain("issues");
    expectNone(text(), ALL_SENTINELS);
    expectNone(JSON.stringify(refused), ALL_SENTINELS);
    await close();
  });

  it("a timeout: the input that was running is not in the logs or the response", async () => {
    const { logger, text } = capturedLogger();
    const { client, close } = await connectClient(buildMcpServer({ tools: [hanging] }, logger));
    const timedOut = await client.callTool({ name: "hanging", arguments: { label: ARGUMENT } });

    expect(JSON.stringify(timedOut)).toContain("timed_out");
    expect(text()).toContain("timed_out");
    expectNone(text(), ALL_SENTINELS);
    expectNone(JSON.stringify(timedOut), ALL_SENTINELS);
    await close();
  });

  it("a cancelled write that settles late: cancellation and late-settlement logs hold no payload", async () => {
    const { logger, text } = capturedLogger();
    const gate = createCommitGate();
    const store = createFakeNoteStore({ beforeCommit: gate.beforeCommit });
    const peer = await connectRawMcp({ tools: [defineCreateNoteTool(store)] }, logger);

    await peer.request(1, "tools/call", {
      name: "create_note",
      arguments: { text: TEXT, idempotencyKey: KEY },
    });
    await gate.whenEntered(1);
    await peer.notify("notifications/cancelled", { requestId: 1, reason: ARGUMENT });
    await vi.waitFor(() => expect(text()).toContain('"outcome":"cancelled"'));

    gate.release(0);
    await vi.waitFor(() => expect(text()).toContain("tool.settled_late"));
    await peer.settle();

    expectNone(text(), ALL_SENTINELS);
    expectNone(JSON.stringify(peer.received), ALL_SENTINELS);
    await peer.close();
  });

  it("a handler that throws after the caller stopped waiting: the late log has the error's name, not its message", async () => {
    const { logger, text } = capturedLogger();
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();

    const lateThrow = defineTool({
      name: "late_throw",
      description: "Throws after being cancelled.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs: 1_000,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({}),
      failures: {},
      execute: async () => {
        started.resolve();
        await gate.promise;
        throw new Error(`late failure: ${LATE_THROWN}`);
      },
    });

    const peer = await connectRawMcp({ tools: [lateThrow] }, logger);

    await peer.request(1, "tools/call", { name: "late_throw", arguments: {} });
    await started.promise;
    await peer.notify("notifications/cancelled", { requestId: 1 });
    await vi.waitFor(() => expect(text()).toContain('"outcome":"cancelled"'));

    gate.resolve();
    await vi.waitFor(() => expect(text()).toContain("tool.settled_late"));

    expect(text()).toContain('"lateOutcome":"threw"');
    expectNone(text(), [LATE_THROWN]);
    await peer.close();
  });

  it("an unexpected error: the MCP response never carries the thrown message", async () => {
    const { logger } = capturedLogger();
    const { client, close } = await connectClient(buildMcpServer({ tools: [throwing] }, logger));
    const failed = await client.callTool({ name: "throwing", arguments: {} });

    expect(failed.isError).toBe(true);
    expect(JSON.stringify(failed)).toContain("internal_error: The tool failed unexpectedly.");
    expectNone(JSON.stringify(failed), [THROWN, "database down"]);
    await close();
  });

  it("an unexpected error: no log line carries the thrown message, name, cause, or stack", async () => {
    const { logger, text } = capturedLogger();

    const hostile = defineTool({
      name: "hostile",
      description: "Throws an error whose every field carries a secret.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs: 1_000,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({}),
      failures: {},
      execute: async () => {
        const error = new Error(`message ${THROWN}`, { cause: new Error(`cause ${THROWN}`) });

        error.name = `name ${THROWN}`;
        error.stack = `stack ${THROWN}`;
        throw error;
      },
    });

    const { client, close } = await connectClient(
      buildMcpServer({ tools: [throwing, hostile, throwingNonError] }, logger),
    );

    for (const name of ["throwing", "hostile", "throwing_non_error"]) {
      const failed = await client.callTool({ name, arguments: {} });

      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).toContain("internal_error: The tool failed unexpectedly.");
      expectNone(JSON.stringify(failed), [THROWN]);
    }

    // The failures are still logged, with a safe classification and nothing from the value.
    expect(text().split("tool.failed").length - 1).toBe(3);
    expect(text()).toContain('"errorClass":"Error"');
    expect(text()).toContain('"errorClass":"other_error"');
    expect(text()).toContain('"errorClass":"non_error_thrown"');
    expect(text()).not.toContain("errorMessage");
    expectNone(text(), [THROWN, "database down"]);
    await close();
  });
});
