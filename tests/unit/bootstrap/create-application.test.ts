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
