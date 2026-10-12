import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createFileNoteStore } from "../../src/adapters/persistence/file-note-store.js";
import { type NoteFiles, nodeNoteFiles } from "../../src/adapters/persistence/note-files.js";
import { systemClock } from "../../src/adapters/system/system-clock.js";
import { createToolExecutor } from "../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../src/app/tools/tool-registry.js";
import { type Application, createApplication } from "../../src/bootstrap/create-application.js";
import { serveMcp } from "../../src/bootstrap/serve-mcp.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { defineReadNoteTool } from "../../src/tools/read-note/read-note-tool.js";
import { connectMcp } from "../helpers/mcp-harness.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";
import { testConfig } from "../helpers/test-config.js";

/**
 * M6 slices interacting over the REAL file note store: quota (S3), the handler ledger (S1),
 * cancellation, and bounded shutdown (S4). The per-slice suites use fakes for the store.
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "m6-cross-slice-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Holds the publication (the link to `<id>.json`) of every note until released. */
function gatedPublication() {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  const files: NoteFiles = {
    ...nodeNoteFiles,
    link: async (existing: string, target: string): Promise<void> => {
      if (target.endsWith(".json")) {
        entered.resolve();
        await gate.promise;
      }

      await nodeNoteFiles.link(existing, target);
    },
  };

  return { files, entered: entered.promise, release: () => gate.resolve() };
}

function storeOver(files: NoteFiles, maxNotes: number) {
  return createFileNoteStore({
    directory: join(root, "notes"),
    slotDirectory: join(root, "note-slots"),
    maxNotes,
    files,
    logger: createRecordingLogger(),
  });
}

async function slotCount(): Promise<number> {
  return (await readdir(join(root, "note-slots"), { withFileTypes: true })).filter(
    (entry) => entry.isDirectory() && /^\d+$/.test(entry.name),
  ).length;
}

async function noteFiles(): Promise<readonly string[]> {
  return (await readdir(join(root, "notes"))).filter((name) => name.endsWith(".json"));
}

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

describe("a cancelled note write that still commits, against the quota", () => {
  it("keeps its slot reserved, so a second note is refused, and the late publication stays within the limit", async () => {
    const publication = gatedPublication();
    const store = storeOver(publication.files, 1);

    const { client, close } = await connectMcp({
      tools: [defineCreateNoteTool(store), defineReadNoteTool(store)],
    });

    const cancel = new AbortController();

    const first = client
      .callTool(
        { name: "create_note", arguments: { text: "first", idempotencyKey: "cross-slice-key-a" } },
        { signal: cancel.signal },
      )
      .catch(() => "cancelled");

    // The slot is claimed before the publication starts, so the write is past the point of no return.
    await publication.entered;
    cancel.abort();
    expect(await first).toBe("cancelled");

    const refused = await client.callTool({
      name: "create_note",
      arguments: { text: "second", idempotencyKey: "cross-slice-key-b" },
    });

    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^execution_failed: The note store is full;/);

    publication.release();

    // The retry of the cancelled request replays the note that did commit; it never makes a second.
    const replay = await client.callTool({
      name: "create_note",
      arguments: { text: "first", idempotencyKey: "cross-slice-key-a" },
    });

    expect(replay.isError).toBeUndefined();
    expect(z.object({ created: z.boolean() }).parse(replay.structuredContent).created).toBe(false);
    expect(await noteFiles()).toHaveLength(1);
    expect(await slotCount()).toBe(1);

    const stillRefused = await client.callTool({
      name: "create_note",
      arguments: { text: "second", idempotencyKey: "cross-slice-key-b" },
    });

    expect(stillRefused.isError).toBe(true);
    await close();
  });
});

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function createNoteRequest(id: number, key: string): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "create_note",
      arguments: { text: "written during shutdown", idempotencyKey: key },
      _meta: MODERN_META,
    },
  })}\n`;
}

/** The production wiring, with a store whose publication the test controls. */
function applicationOver(files: NoteFiles, logger: ReturnType<typeof createRecordingLogger>) {
  const base = createApplication(testConfig({ dataDir: root, maxNotes: 5 }));
  const tools = createToolRegistry([defineCreateNoteTool(storeOver(files, 5))]);

  const application: Application = {
    ...base,
    logger,
    tools,
    executeTool: createToolExecutor({
      registry: tools,
      clock: systemClock,
      logger,
      maxResultBytes: base.config.maxToolResultBytes,
      handlerLedger: base.handlerLedger,
    }),
  };

  return application;
}

const silentStdout = () =>
  new Writable({
    write: (_chunk, _encoding, callback): void => {
      callback();
    },
  });

describe("shutdown while a real note write is past its commit point", () => {
  it("waits for the write to publish, then ends cleanly, with the note whole and the quota intact", async () => {
    const publication = gatedPublication();
    const logger = createRecordingLogger();
    const application = applicationOver(publication.files, logger);
    const stdin = new PassThrough();
    let ended = false;

    const serving = serveMcp(application, {
      stdin,
      stdout: silentStdout(),
      signal: new AbortController().signal,
      shutdownGraceMs: 5_000,
    }).then((outcome) => {
      ended = true;

      return outcome;
    });

    stdin.write(createNoteRequest(1, "cross-slice-shutdown-a"));
    await publication.entered;
    stdin.end();

    // The connection is closed and the call cancelled, but the handler is in its link: not done.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ended).toBe(false);
    expect(application.handlerLedger.counts()).toEqual({ unsettled: 1, abandoned: 1 });

    publication.release();

    expect(await serving).toBe("closed");
    expect(application.handlerLedger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    expect(logger.entries.some((entry) => entry.message === "mcp.shutdown_incomplete")).toBe(false);
    expect(await noteFiles()).toHaveLength(1);
    expect(await slotCount()).toBe(1);
  });

  it("gives up after the grace when the write never finishes, and says what it left behind", async () => {
    const publication = gatedPublication();
    const logger = createRecordingLogger();
    const application = applicationOver(publication.files, logger);
    const stdin = new PassThrough();

    const serving = serveMcp(application, {
      stdin,
      stdout: silentStdout(),
      signal: new AbortController().signal,
      shutdownGraceMs: 100,
    });

    stdin.write(createNoteRequest(1, "cross-slice-shutdown-b"));
    await publication.entered;
    stdin.end();

    expect(await serving).toBe("closed");

    const incomplete = logger.entries.filter(
      (entry) => entry.message === "mcp.shutdown_incomplete",
    );

    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.fields).toMatchObject({ unsettledHandlers: 1, abandonedHandlers: 1 });
    expect(JSON.stringify(logger.entries)).not.toContain("written during shutdown");

    // Free the gate so the test leaves no pending write behind.
    publication.release();
  });
});
