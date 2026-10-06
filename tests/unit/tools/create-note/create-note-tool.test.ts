import { afterEach, describe, expect, it, vi } from "vitest";
import { createToolExecutor, type ToolExecutor } from "../../../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../../../src/app/tools/tool-registry.js";
import type { JsonObject } from "../../../../src/domain/json-value.js";
import type { Result } from "../../../../src/domain/result.js";
import type { ToolExecutionError } from "../../../../src/domain/tool-execution-error.js";
import type { CreateNoteOutcome, NoteStore } from "../../../../src/ports/note-store.js";
import { defineCreateNoteTool } from "../../../../src/tools/create-note/create-note-tool.js";
import { createFakeClock, type FakeClock } from "../../../helpers/fake-clock.js";
import { createFakeNoteStore, type FakeNoteStore } from "../../../helpers/fake-note-store.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";

const realSetImmediate = setImmediate;

/** Lets every pending promise chain settle, even while timers are faked. */
async function flush(): Promise<void> {
  await new Promise((resolve) => realSetImmediate(resolve));
}

const KEY = "note-key-0123456789";

const TEXT = "Buy milk on the way home";

const TIMEOUT_MS = 5_000;

interface Harness {
  readonly execute: ToolExecutor;
  readonly logger: RecordingLogger;
  readonly clock: FakeClock;
}

function harness(store: NoteStore): Harness {
  const logger = createRecordingLogger();
  const clock = createFakeClock();

  return {
    execute: createToolExecutor({
      registry: createToolRegistry([defineCreateNoteTool(store)]),
      clock,
      logger,
      maxResultBytes: 16_384,
    }),
    logger,
    clock,
  };
}

function createNote(
  execute: ToolExecutor,
  args: JsonObject,
  signal: AbortSignal = new AbortController().signal,
  id = "call-1",
): Promise<Result<JsonObject, ToolExecutionError>> {
  return execute({ id, name: "create_note", arguments: args }, signal);
}

function codeOf(result: Result<JsonObject, ToolExecutionError>): string {
  return result.ok ? "ok" : result.error.code;
}

function storeReturning(outcome: CreateNoteOutcome): NoteStore {
  return {
    create: async () => outcome,
    read: async () => ({ status: "not_found" }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("create_note: creating and replaying", () => {
  it("saves a new note and reports it as created", async () => {
    const store = createFakeNoteStore();
    const { execute } = harness(store);

    const result = await createNote(execute, { text: TEXT, idempotencyKey: KEY });

    expect(result).toEqual({
      ok: true,
      value: {
        noteId: expect.stringMatching(/^[0-9a-f]{32}$/),
        createdAt: "2026-01-02T03:04:05.000Z",
        created: true,
      },
    });
    expect([...store.notes.values()].map((note) => note.text)).toEqual([TEXT]);
  });

  it("replays the original note for the same key and text, without writing again", async () => {
    const store = createFakeNoteStore();
    const { execute, clock } = harness(store);

    const first = await createNote(execute, { text: TEXT, idempotencyKey: KEY });
    clock.advance(60_000);
    const replay = await createNote(execute, { text: TEXT, idempotencyKey: KEY });

    const { noteId } = first.ok ? first.value : {};

    expect(noteId).toEqual(expect.any(String));
    expect(replay).toEqual({
      ok: true,
      value: {
        noteId,
        createdAt: "2026-01-02T03:04:05.000Z",
        created: false,
      },
    });
    expect(store.notes.size).toBe(1);
  });

  it("rejects the same key with different text as a conflict and keeps the original", async () => {
    const store = createFakeNoteStore();
    const { execute, logger } = harness(store);

    await createNote(execute, { text: TEXT, idempotencyKey: KEY });
    const conflict = await createNote(execute, { text: "Something else", idempotencyKey: KEY });

    expect(conflict).toEqual({
      ok: false,
      error: {
        code: "execution_failed",
        message:
          "This idempotency key was already used for a note with different text. Use a new key " +
          "for a new note.",
      },
    });
    expect([...store.notes.values()].map((note) => note.text)).toEqual([TEXT]);
    expect(logger.entries.at(-1)?.fields).toEqual(
      expect.objectContaining({ failureReason: "idempotency_key_conflict" }),
    );
  });

  it("treats text that differs only in case or whitespace as different text", async () => {
    const store = createFakeNoteStore();
    const { execute } = harness(store);

    await createNote(execute, { text: TEXT, idempotencyKey: KEY });

    for (const text of [TEXT.toUpperCase(), `${TEXT} `]) {
      expect(codeOf(await createNote(execute, { text, idempotencyKey: KEY }))).toBe(
        "execution_failed",
      );
    }
  });

  it("creates separate notes for different keys with the same text", async () => {
    const store = createFakeNoteStore();
    const { execute } = harness(store);

    const one = await createNote(execute, { text: TEXT, idempotencyKey: `${KEY}-a` });
    const two = await createNote(execute, { text: TEXT, idempotencyKey: `${KEY}-b` });

    const ids = [one, two]
      .map((result) => (result.ok ? result.value : {}))
      .map(({ noteId }) => noteId);

    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(undefined);
    expect(store.notes.size).toBe(2);
  });

  it("commits one note for concurrent calls with the same key", async () => {
    const store = createFakeNoteStore({ beforeCommit: async () => Promise.resolve() });
    const { execute } = harness(store);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createNote(execute, { text: TEXT, idempotencyKey: KEY }, undefined, `call-${index}`),
      ),
    );

    const created = results
      .map((result) => (result.ok ? result.value : {}))
      .map(({ created }) => created);

    expect(created.filter((flag) => flag === true)).toHaveLength(1);
    expect(created.filter((flag) => flag === false)).toHaveLength(9);
    expect(store.notes.size).toBe(1);
  });
});

describe("create_note: input", () => {
  it.each([
    ["no key", { text: TEXT }],
    ["a null key", { text: TEXT, idempotencyKey: null }],
    ["a key that is too short", { text: TEXT, idempotencyKey: "a".repeat(15) }],
    ["a key that is too long", { text: TEXT, idempotencyKey: "a".repeat(65) }],
    ["a key with a path separator", { text: TEXT, idempotencyKey: "../../etc/passwd-x" }],
    ["a key with a space", { text: TEXT, idempotencyKey: "note key 0123456789" }],
    ["a key with non-ASCII letters", { text: TEXT, idempotencyKey: "nöte-key-0123456789" }],
    ["empty text", { text: "", idempotencyKey: KEY }],
    ["text that is too long", { text: "x".repeat(2_001), idempotencyKey: KEY }],
    ["an unknown property", { text: TEXT, idempotencyKey: KEY, path: "/tmp/x" }],
  ])("rejects %s before reaching the store", async (_label, args) => {
    const store = createFakeNoteStore();
    const { execute } = harness(store);

    expect(codeOf(await createNote(execute, args))).toBe("invalid_input");
    expect(store.calls.create).toBe(0);
  });

  it("accepts the boundary lengths", async () => {
    const store = createFakeNoteStore();
    const { execute } = harness(store);

    const shortest = await createNote(execute, { text: "x", idempotencyKey: "a".repeat(16) });

    const longest = await createNote(execute, {
      text: "x".repeat(2_000),
      idempotencyKey: "b".repeat(64),
    });

    expect([codeOf(shortest), codeOf(longest)]).toEqual(["ok", "ok"]);
  });

  it("does not echo a rejected key or text in the message or the logs", async () => {
    const { execute, logger } = harness(createFakeNoteStore());
    const text = `sk-secret-text-${"x".repeat(2_000)}`;

    const result = await createNote(execute, { text, idempotencyKey: "sk secret key 0123" });

    expect(JSON.stringify([result, logger.entries])).not.toMatch(/sk-secret-text|sk secret key/);
  });
});

describe("create_note: store failures", () => {
  it.each([
    [
      { status: "unavailable" },
      "storage_unavailable",
      "The note store is unavailable; this call did not save the note. Retrying the same " +
        "request is safe.",
    ],
    [
      { status: "unreadable" },
      "note_unreadable",
      "A note already exists for this request but cannot be read.",
    ],
  ] satisfies [CreateNoteOutcome, string, string][])(
    "maps %j to its declared, static message",
    async (outcome, reason, message) => {
      const { execute, logger } = harness(storeReturning(outcome));

      const result = await createNote(execute, { text: TEXT, idempotencyKey: KEY });

      expect(result).toEqual({ ok: false, error: { code: "execution_failed", message } });
      expect(logger.entries).toEqual([
        expect.objectContaining({
          level: "warn",
          fields: expect.objectContaining({ outcome: "execution_failed", failureReason: reason }),
        }),
      ]);
    },
  );

  it("reports a store that throws as an internal error with an unknown outcome", async () => {
    const store: NoteStore = {
      create: async () => {
        throw new Error("unexpected");
      },
      read: async () => ({ status: "not_found" }),
    };

    const { execute } = harness(store);

    expect(codeOf(await createNote(execute, { text: TEXT, idempotencyKey: KEY }))).toBe(
      "internal_error",
    );
  });

  it("never logs the note text or the key", async () => {
    const { execute, logger } = harness(createFakeNoteStore());

    await createNote(execute, { text: TEXT, idempotencyKey: KEY });
    await createNote(execute, { text: TEXT, idempotencyKey: KEY });
    await createNote(execute, { text: "other", idempotencyKey: KEY });

    const logged = JSON.stringify(logger.entries);

    expect(logged).not.toContain(TEXT);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain("other");
  });
});

/**
 * A handler that ignores its signal keeps running after the executor reports `timed_out` or
 * `cancelled`. The fake's gate holds the first call inside its commit window; the retry reuses the
 * key. Whichever commits first, exactly one note exists.
 */
describe("create_note: retry after an unknown outcome", () => {
  interface GatedStore {
    readonly store: FakeNoteStore;
    readonly release: () => void;
  }

  function gatedStore(): GatedStore {
    const gate = Promise.withResolvers<void>();

    const store = createFakeNoteStore({
      beforeCommit: async (callIndex) => (callIndex === 0 ? gate.promise : undefined),
    });

    return { store, release: () => gate.resolve() };
  }

  const ARGS = { text: TEXT, idempotencyKey: KEY };

  it("replays when the timed-out call commits before the retry", async () => {
    vi.useFakeTimers();

    const { store, release } = gatedStore();
    const { execute, logger } = harness(store);

    const original = createNote(execute, ARGS, undefined, "call-original");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(codeOf(await original)).toBe("timed_out");

    release();
    await flush();

    expect(store.notes.size).toBe(1);

    const retry = await createNote(execute, ARGS, undefined, "call-retry");
    const [note] = store.notes.values();

    expect(retry).toEqual({
      ok: true,
      value: { noteId: note?.id, createdAt: "2026-01-02T03:04:05.000Z", created: false },
    });
    expect(store.notes.size).toBe(1);
    expect(
      logger.entries.map(({ message, fields: { toolCallId } }) => [message, toolCallId]),
    ).toEqual([
      ["tool.failed", "call-original"],
      ["tool.settled_late", "call-original"],
      ["tool.completed", "call-retry"],
    ]);
    expect(logger.entries[1]?.fields).toEqual(
      expect.objectContaining({ lateOutcome: "returned", toolName: "create_note" }),
    );
  });

  it("does not duplicate when the retry commits before the timed-out call", async () => {
    vi.useFakeTimers();

    const { store, release } = gatedStore();
    const { execute, logger } = harness(store);

    const original = createNote(execute, ARGS, undefined, "call-original");
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(codeOf(await original)).toBe("timed_out");

    const retry = await createNote(execute, ARGS, undefined, "call-retry");

    expect(retry).toEqual({ ok: true, value: expect.objectContaining({ created: true }) });

    release();
    await flush();

    expect(store.notes.size).toBe(1);
    expect(logger.entries.at(-1)).toEqual(
      expect.objectContaining({
        message: "tool.settled_late",
        fields: expect.objectContaining({ toolCallId: "call-original", lateOutcome: "returned" }),
      }),
    );
  });

  it("does not duplicate when the caller cancels mid-write and then retries", async () => {
    const { store, release } = gatedStore();
    const { execute } = harness(store);
    const caller = new AbortController();

    const original = createNote(execute, ARGS, caller.signal, "call-original");
    caller.abort();

    expect(codeOf(await original)).toBe("cancelled");

    release();
    await flush();

    const retry = await createNote(execute, ARGS, undefined, "call-retry");

    expect(retry).toEqual({ ok: true, value: expect.objectContaining({ created: false }) });
    expect(store.notes.size).toBe(1);
  });

  it("never reaches the store when the caller cancelled before the call", async () => {
    const store = createFakeNoteStore();
    const { execute } = harness(store);

    expect(codeOf(await createNote(execute, ARGS, AbortSignal.abort()))).toBe("cancelled");
    expect(store.calls.create).toBe(0);
  });
});
