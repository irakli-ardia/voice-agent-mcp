import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIST_CLI_ENTRY, withMcpChild } from "../../helpers/mcp-child.js";
import { callToolRequest, toolResultOf } from "../../helpers/mcp-wire.js";

/**
 * The built server with `MAX_NOTES` set, in a real process on plain node: the quota reaches the
 * note store through configuration, and two server processes share one `DATA_DIR`.
 */
let data: string;

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "mcp-dist-quota-"));
});

afterEach(async () => {
  await rm(data, { recursive: true, force: true });
});

const create = (id: number, label: number) =>
  callToolRequest(id, "create_note", {
    text: "a note",
    idempotencyKey: `dist-quota-key-${String(label).padStart(6, "0")}`,
  });

async function withServer<T>(
  maxNotes: string,
  body: (call: (label: number) => Promise<{ isError?: boolean | undefined }>) => Promise<T>,
): Promise<T> {
  return withMcpChild(
    {
      entry: DIST_CLI_ENTRY,
      compiled: true,
      args: ["mcp"],
      env: { DATA_DIR: data, MAX_NOTES: maxNotes, LOG_LEVEL: "silent" },
    },
    async (child) => {
      let id = 0;

      return body(async (label) => {
        id += 1;
        await child.send(create(id, label));

        return toolResultOf(child, id);
      });
    },
  );
}

describe("the built server and MAX_NOTES", () => {
  it("refuses a new note over MAX_NOTES and still replays a saved one", async () => {
    await withServer("2", async (call) => {
      expect((await call(1)).isError).toBeUndefined();
      expect((await call(2)).isError).toBeUndefined();
      expect((await call(3)).isError).toBe(true);
      expect((await call(1)).isError).toBeUndefined();
    });

    const names = await readdir(join(data, "notes"));

    expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(2);
  });

  it("shares the quota between server processes on one DATA_DIR", async () => {
    await withServer("2", async (call) => {
      expect((await call(1)).isError).toBeUndefined();
      expect((await call(2)).isError).toBeUndefined();
    });

    // A second process, started later, sees the first one's notes and refuses a third.
    await withServer("2", async (call) => {
      expect((await call(3)).isError).toBe(true);
      expect((await call(2)).isError).toBeUndefined();
    });
  });

  it("rejects an invalid MAX_NOTES at start, naming the variable and not the value", async () => {
    await withMcpChild(
      {
        entry: DIST_CLI_ENTRY,
        compiled: true,
        args: ["mcp"],
        env: { DATA_DIR: data, MAX_NOTES: "sk-secret-quota", LOG_LEVEL: "silent" },
      },
      async (child) => {
        const exit = await child.exited;

        expect(exit.code).toBe(78);
        expect(child.stderrText()).toContain("MAX_NOTES");
        expect(child.stderrText()).not.toContain("sk-secret-quota");
      },
    );
  });
});
