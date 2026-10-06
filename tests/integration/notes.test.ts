import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFileNoteStore,
  type NoteFiles,
  nodeNoteFiles,
} from "../../src/adapters/persistence/file-note-store.js";
import { createToolExecutor, type ToolExecutor } from "../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../src/app/tools/tool-registry.js";
import { createApplication } from "../../src/bootstrap/create-application.js";
import type { Config } from "../../src/config/config.js";
import type { LogFields, Logger } from "../../src/ports/logger.js";
import { defineCreateNoteTool } from "../../src/tools/create-note/create-note-tool.js";
import { defineReadNoteTool } from "../../src/tools/read-note/read-note-tool.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";

const KEY = "integration-key-0123";

const TEXT = "sk-integration-text: renew passport";

const CREATE_TIMEOUT_MS = 5_000;

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "notes-integration-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(dataDir, { recursive: true, force: true });
});

async function noteFiles(): Promise<string[]> {
  return readdir(join(dataDir, "notes"));
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

interface GatedLink {
  readonly files: NoteFiles;
  /** Resolves once the first link call is waiting at the gate. */
  readonly reached: Promise<void>;
  readonly release: () => void;
}

/** Holds the first link (the commit) until released; later links run at once. */
function gateFirstLink(): GatedLink {
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let calls = 0;

  return {
    files: {
      ...nodeNoteFiles,
      link: async (existingPath: string, newPath: string): Promise<void> => {
        calls += 1;

        if (calls === 1) {
          reached.resolve();
          await gate.promise;
        }

        return nodeNoteFiles.link(existingPath, newPath);
      },
    },
    reached: reached.promise,
    release: () => gate.resolve(),
  };
}

interface Harness {
  readonly execute: ToolExecutor;
  readonly logger: RecordingLogger;
  /** Resolves when the executor logs `tool.settled_late`. */
  readonly settledLate: Promise<LogFields>;
}

function harness(files: NoteFiles): Harness {
  const logger = createRecordingLogger();
  const settledLate = Promise.withResolvers<LogFields>();

  const observed: Logger = {
    ...logger,
    warn: (message: string, fields?: LogFields): void => {
      logger.warn(message, fields);

      if (message === "tool.settled_late") {
        settledLate.resolve(fields ?? {});
      }
    },
  };

  const notes = createFileNoteStore({ directory: join(dataDir, "notes"), logger: observed, files });

  return {
    execute: createToolExecutor({
      registry: createToolRegistry([defineCreateNoteTool(notes), defineReadNoteTool(notes)]),
      clock: createFakeClock(),
      logger: observed,
      maxResultBytes: 16_384,
    }),
    logger,
    settledLate: settledLate.promise,
  };
}

function create(execute: ToolExecutor, id: string): ReturnType<ToolExecutor> {
  return execute(
    { id, name: "create_note", arguments: { text: TEXT, idempotencyKey: KEY } },
    signal(),
  );
}

/**
 * The real store under the real executor: the first call's commit is held at the link until its
 * deadline has passed, as with a slow disk. Only timers are faked; file I/O is real.
 */
describe("notes on the real file store: retry after timed_out", () => {
  it("replays when the timed-out call commits before the retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const gated = gateFirstLink();
    const { execute, logger, settledLate } = harness(gated.files);

    const original = create(execute, "call-original");
    await gated.reached;
    await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);

    expect(await original).toEqual(expect.objectContaining({ ok: false }));
    expect(logger.entries[0]?.fields).toEqual(expect.objectContaining({ outcome: "timed_out" }));

    gated.release();

    expect(await settledLate).toEqual(expect.objectContaining({ lateOutcome: "returned" }));

    const retry = await create(execute, "call-retry");

    expect(retry).toEqual({ ok: true, value: expect.objectContaining({ created: false }) });
    expect(await noteFiles()).toHaveLength(1);
    expect((await noteFiles())[0]).toMatch(/^[0-9a-f]{32}\.json$/);
  });

  it("does not duplicate when the retry commits before the timed-out call", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const gated = gateFirstLink();
    const { execute, settledLate } = harness(gated.files);

    const original = create(execute, "call-original");
    await gated.reached;
    await vi.advanceTimersByTimeAsync(CREATE_TIMEOUT_MS);
    await original;

    const retry = await create(execute, "call-retry");

    expect(retry).toEqual({ ok: true, value: expect.objectContaining({ created: true }) });

    gated.release();

    // Its link loses with EEXIST; reading the winner with its already-aborted signal is an abort.
    expect(await settledLate).toEqual(
      expect.objectContaining({ lateOutcome: "threw", errorName: "AbortError" }),
    );
    expect(await noteFiles()).toHaveLength(1);
  });
});

describe("notes through the composition root", () => {
  it("replays a key and reads the note after the application is recreated", async () => {
    const config: Config = { logLevel: "silent", maxToolResultBytes: 16_384, dataDir };
    const first = await create(createApplication(config).executeTool, "call-1");
    const restarted = createApplication(config).executeTool;
    const replay = await create(restarted, "call-2");

    const { noteId, createdAt } = first.ok ? first.value : {};

    expect(first).toEqual({ ok: true, value: expect.objectContaining({ created: true }) });
    expect(replay).toEqual({ ok: true, value: { noteId, createdAt, created: false } });
    expect(
      await restarted({ id: "call-3", name: "read_note", arguments: { noteId } }, signal()),
    ).toEqual({ ok: true, value: { noteId, text: TEXT, createdAt } });
  });

  it("returns a conflict, not a second note, for the same key with different text", async () => {
    const { executeTool } = createApplication({
      logLevel: "silent",
      maxToolResultBytes: 16_384,
      dataDir,
    });

    await create(executeTool, "call-1");

    const conflict = await executeTool(
      { id: "call-2", name: "create_note", arguments: { text: "other", idempotencyKey: KEY } },
      signal(),
    );

    expect(conflict.ok ? "ok" : conflict.error.code).toBe("execution_failed");
    expect(await noteFiles()).toHaveLength(1);
  });

  it("lets one of 50 concurrent same-key calls with different text create, and the rest conflict", async () => {
    const { executeTool } = createApplication({
      logLevel: "silent",
      maxToolResultBytes: 16_384,
      dataDir,
    });

    const texts = Array.from({ length: 50 }, (_, index) => `concurrent text ${index}`);

    const results = await Promise.all(
      texts.map((text, index) =>
        executeTool(
          { id: `call-${index}`, name: "create_note", arguments: { text, idempotencyKey: KEY } },
          signal(),
        ),
      ),
    );

    const outcomes = results.map((result) => {
      if (!result.ok) {
        return result.error.message;
      }

      const { created } = result.value;

      return `created:${String(created)}`;
    });

    const conflict =
      "This idempotency key was already used for a note with different text. Use a new key " +
      "for a new note.";

    expect(outcomes.filter((outcome) => outcome === "created:true")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === conflict)).toHaveLength(49);
    expect(await noteFiles()).toHaveLength(1);

    const [noteFile = ""] = await noteFiles();
    const stored = JSON.parse(await readFile(join(dataDir, "notes", noteFile), "utf8"));

    expect(texts.indexOf(stored.text)).toBe(outcomes.indexOf("created:true"));
  });

  it("never logs the note text, the key, or a path", async () => {
    const gated = gateFirstLink();
    const { execute, logger } = harness(gated.files);

    gated.release();
    await create(execute, "call-1");
    await create(execute, "call-2");
    await execute(
      { id: "call-3", name: "read_note", arguments: { noteId: "0".repeat(32) } },
      signal(),
    );

    const logged = JSON.stringify(logger.entries);

    expect(logger.entries.length).toBeGreaterThan(0);
    expect(logged).not.toContain("sk-integration-text");
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain(dataDir.replaceAll("\\", "\\\\"));
    expect(logged).not.toContain(dataDir);
  });
});
