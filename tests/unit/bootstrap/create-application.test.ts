import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import type { Config } from "../../../src/config/config.js";
import { testConfig } from "../../helpers/test-config.js";

let CONFIG: Config;

beforeEach(async () => {
  CONFIG = testConfig({ dataDir: await mkdtemp(join(tmpdir(), "create-application-")) });
});

afterEach(async () => {
  await rm(CONFIG.dataDir, { recursive: true, force: true });
});

describe("createApplication", () => {
  it("wires a logger for the given config", () => {
    const application = createApplication(CONFIG);
    expect(application.config).toEqual(CONFIG);
    expect(() => application.logger.child({ turnId: "t-1" }).info("ready")).not.toThrow();
  });

  it("registers the canonical tools", () => {
    expect(createApplication(CONFIG).tools.tools.map((tool) => tool.name)).toEqual([
      "get_current_time",
      "calculate",
      "create_note",
      "read_note",
    ]);
  });

  it("touches no disk until a note is written", () => {
    const dataDir = join(CONFIG.dataDir, "not-yet");

    createApplication({ ...CONFIG, dataDir });

    expect(existsSync(dataDir)).toBe(false);
  });

  it("saves notes under DATA_DIR/notes and reads them back through the executor", async () => {
    const { executeTool } = createApplication(CONFIG);
    const signal = new AbortController().signal;

    const created = await executeTool(
      {
        id: "call-1",
        name: "create_note",
        arguments: { text: "Water the plants", idempotencyKey: "bootstrap-key-0123" },
      },
      signal,
    );

    const { noteId } = created.ok ? created.value : {};

    expect(existsSync(join(CONFIG.dataDir, "notes", `${String(noteId)}.json`))).toBe(true);
    expect(
      await executeTool({ id: "call-2", name: "read_note", arguments: { noteId } }, signal),
    ).toEqual({ ok: true, value: expect.objectContaining({ text: "Water the plants" }) });
  });

  it("tracks every invoked handler in the ledger it exposes, until the handler settles", async () => {
    const { executeTool, handlerLedger } = createApplication(CONFIG);

    const pending = executeTool(
      { id: "call-1", name: "calculate", arguments: { operation: "add", a: 1, b: 2 } },
      new AbortController().signal,
    );

    expect(handlerLedger.counts()).toEqual({ unsettled: 1, abandoned: 0 });

    await pending;
    await handlerLedger.idle();

    expect(handlerLedger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
  });

  it("takes the abandoned-handler limit from the configuration", async () => {
    const { executeTool, handlerLedger } = createApplication({
      ...CONFIG,
      maxAbandonedToolHandlers: 1,
    });

    const cancel = new AbortController();

    const first = executeTool(
      {
        id: "call-1",
        name: "create_note",
        arguments: { text: "first", idempotencyKey: "limit-key-000000001" },
      },
      cancel.signal,
    );

    // The note write needs real filesystem turns, so the handler is still running when the
    // executor stops waiting: it is abandoned, and the one-handler limit is reached.
    cancel.abort();

    expect(await first).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "cancelled" }),
    });
    expect(handlerLedger.counts().abandoned).toBe(1);

    expect(
      await executeTool(
        {
          id: "call-2",
          name: "create_note",
          arguments: { text: "second", idempotencyKey: "limit-key-000000002" },
        },
        new AbortController().signal,
      ),
    ).toEqual({ ok: false, error: expect.objectContaining({ code: "overloaded" }) });

    await handlerLedger.idle();
  });

  it("takes the note quota from the configuration and reports a full store with a static failure", async () => {
    const { executeTool } = createApplication({ ...CONFIG, maxNotes: 1 });
    const signal = new AbortController().signal;

    const call = async (id: string, key: string) =>
      executeTool(
        { id, name: "create_note", arguments: { text: "Water the plants", idempotencyKey: key } },
        signal,
      );

    expect((await call("call-1", "quota-key-000000001")).ok).toBe(true);

    expect(await call("call-2", "quota-key-000000002")).toEqual({
      ok: false,
      error: {
        code: "execution_failed",
        message: expect.stringContaining("The note store is full"),
      },
    });

    // The note already saved is still a replay, not a refusal.
    expect(await call("call-3", "quota-key-000000001")).toEqual({
      ok: true,
      value: expect.objectContaining({ created: false }),
    });
  });

  it("keeps the note slots beside the notes, in DATA_DIR", async () => {
    const { executeTool } = createApplication(CONFIG);

    await executeTool(
      {
        id: "call-1",
        name: "create_note",
        arguments: { text: "Water the plants", idempotencyKey: "slot-key-0000000001" },
      },
      new AbortController().signal,
    );

    expect(existsSync(join(CONFIG.dataDir, "note-slots", "0"))).toBe(true);
  });

  it("runs a registered tool through the executor with the system clock", async () => {
    const { executeTool } = createApplication(CONFIG);
    const signal = new AbortController().signal;

    const sum = await executeTool(
      { id: "call-1", name: "calculate", arguments: { operation: "add", a: 2, b: 3 } },
      signal,
    );

    const time = await executeTool(
      { id: "call-2", name: "get_current_time", arguments: { timeZone: null } },
      signal,
    );

    expect(sum).toEqual({ ok: true, value: { result: 5 } });
    expect(time).toEqual({
      ok: true,
      value: expect.objectContaining({ timeZone: "UTC", isoTime: expect.stringMatching(/Z$/) }),
    });
  });

  it("applies the configured result size cap", async () => {
    const { executeTool } = createApplication({ ...CONFIG, maxToolResultBytes: 5 });

    const result = await executeTool(
      { id: "call-1", name: "calculate", arguments: { operation: "add", a: 2, b: 3 } },
      new AbortController().signal,
    );

    expect(result.ok ? "ok" : result.error.code).toBe("output_too_large");
  });
});

describe("createApplication logging", () => {
  it("flushes at once when logging is synchronous", async () => {
    await expect(createApplication(CONFIG).flushLogs(1_000)).resolves.toBeUndefined();
  });

  it("flushes the bounded stderr queue when logging is non-blocking", async () => {
    const application = createApplication(CONFIG, { stderr: "non-blocking" });

    // The test configuration is silent, so nothing is queued; flushing must still finish.
    application.logger.info("create-application test: nothing is written at silent");
    await expect(application.flushLogs(1_000)).resolves.toBeUndefined();
  });
});
