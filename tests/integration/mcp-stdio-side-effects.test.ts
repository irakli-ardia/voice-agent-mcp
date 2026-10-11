import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_TERMINATED } from "../../src/entrypoints/exit-codes.js";
import {
  CLI_ENTRY,
  GATED_WRITE_ENTRY,
  type McpChild,
  withinLimit,
  withMcpChild,
} from "../helpers/mcp-child.js";
import {
  callToolRequest,
  cancelNotification,
  modernRequest,
  toolResultOf,
} from "../helpers/mcp-wire.js";

/**
 * Real processes, real stdio, real file store. The gated server holds each note write inside its
 * commit window until the test releases it over IPC, so every case below acts while a keyed write
 * is genuinely in progress, and waits on messages from the child, never on sleeps.
 */
vi.setConfig({ testTimeout: 60_000 });

const KEY = "stdio-write-key-000001";

const OTHER_KEY = "stdio-write-key-000002";

const THIRD_KEY = "stdio-write-key-000003";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-side-effects-"));

  directories.push(dir);

  return dir;
}

async function noteCount(dir: string): Promise<number> {
  return (await readdir(join(dir, "notes")).catch(() => [])).length;
}

function gated(env: Readonly<Record<string, string>>) {
  return { entry: GATED_WRITE_ENTRY, args: ["src"], env };
}

function production(env: Readonly<Record<string, string>>) {
  return { entry: CLI_ENTRY, args: ["mcp"], env };
}

const noteSchema = z.object({ noteId: z.string(), created: z.boolean() });

function createNote(id: number, text: string, idempotencyKey: string) {
  return callToolRequest(id, "create_note", { text, idempotencyKey });
}

/** Sends one write and waits until it is inside the commit window, so write indexes follow request order. */
async function startWrite(child: McpChild, id: number, text: string, key: string, index: number) {
  await child.send(createNote(id, text, key));
  await child.whenIpc("write-entered", index);
}

function release(child: McpChild, ...indexes: readonly number[]): void {
  for (const index of indexes) {
    child.sendIpc({ type: "release", index });
  }
}

/** Once this answers, everything the server wrote before it has been written. */
async function settle(child: McpChild, id: number): Promise<void> {
  await child.send(modernRequest(id, "tools/list"));
  await child.whenResponse(id);
}

function ipcTypes(child: McpChild, type: string): readonly number[] {
  return child.ipc.filter(({ type: kind }) => kind === type).map(({ index }) => Number(index));
}

describe("cancellation over real stdio", () => {
  it("aborts only the cancelled write, answers the other, lets both commit, and replays the cancelled key", async () => {
    const dir = await dataDirectory();

    await withMcpChild(gated({ DATA_DIR: dir }), async (child) => {
      await startWrite(child, 1, "cancelled", KEY, 0);
      await startWrite(child, 2, "survivor", OTHER_KEY, 1);

      await child.send(cancelNotification(1));
      await child.whenIpc("write-aborted", 0);

      // The other write was not touched by the cancel.
      expect(ipcTypes(child, "write-aborted")).toEqual([0]);

      release(child, 1, 0, 2);
      await child.whenIpc("write-committed", 0);
      await child.whenIpc("write-committed", 1);

      const survivor = noteSchema.parse((await toolResultOf(child, 2)).structuredContent);

      expect(survivor.created).toBe(true);

      // The server answered a later request, so any answer owed to request 1 would be out by now.
      await settle(child, 3);
      expect(child.responsesTo(1)).toEqual([]);

      // The cancelled write did commit, and its key replays instead of writing again.
      await child.send(createNote(4, "cancelled", KEY));

      const replay = noteSchema.parse((await toolResultOf(child, 4)).structuredContent);

      expect(replay.created).toBe(false);
      expect(await noteCount(dir)).toBe(2);
      expect(child.strayStdout()).toEqual([]);
      child.endStdin();
      expect((await withinLimit(child.exited, "the server to exit")).code).toBe(EXIT_OK);
    });
  });
});

describe("stdin EOF during a keyed write (real process)", () => {
  it("aborts the request, sends no response, lets the write commit, and a retry writes nothing new", async () => {
    const dir = await dataDirectory();

    await withMcpChild(gated({ DATA_DIR: dir }), async (child) => {
      await startWrite(child, 1, "written after EOF", KEY, 0);

      child.endStdin();
      await child.whenIpc("write-aborted", 0);

      // Nothing was written to stdout, and the write has not committed yet.
      expect(child.stdoutLines).toEqual([]);
      expect(ipcTypes(child, "write-committed")).toEqual([]);

      release(child, 0);
      await child.whenIpc("write-committed", 0);

      // End of input is a normal end: the process leaves cleanly once the write it started is done.
      const { code, signal } = await withinLimit(child.exited, "the server to exit after EOF");

      expect({ code, signal }).toEqual({ code: EXIT_OK, signal: null });
      expect(child.stdoutLines).toEqual([]);
      expect(child.stdoutRemainder()).toBe("");
      expect(child.responsesTo(1)).toEqual([]);
    });

    expect(await noteCount(dir)).toBe(1);

    // A retry with the same key, against the shipped command, finds the note instead of writing again.
    await withMcpChild(production({ DATA_DIR: dir }), async (retry) => {
      await retry.send(createNote(1, "written after EOF", KEY));

      const replay = noteSchema.parse((await toolResultOf(retry, 1)).structuredContent);

      expect(replay.created).toBe(false);
      retry.endStdin();
      expect((await withinLimit(retry.exited, "the retry server to exit")).code).toBe(EXIT_OK);
    });

    expect(await noteCount(dir)).toBe(1);
  });
});

describe("the in-flight limit over real stdio", () => {
  it("runs writes concurrently up to the limit, refuses the next without touching its key, then recovers", async () => {
    const dir = await dataDirectory();

    await withMcpChild(gated({ DATA_DIR: dir, MCP_MAX_IN_FLIGHT_CALLS: "2" }), async (child) => {
      // Both writes are inside their commit windows at the same time: they run concurrently.
      await startWrite(child, 1, "first", KEY, 0);
      await startWrite(child, 2, "second", OTHER_KEY, 1);

      await child.send(createNote(3, "refused", THIRD_KEY));

      const refused = await toolResultOf(child, 3);

      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toBe(
        "server_busy: Too many tool calls are in flight; retry later.",
      );
      expect(ipcTypes(child, "write-entered")).toEqual([0, 1]);

      release(child, 0, 1, 2);

      expect(noteSchema.parse((await toolResultOf(child, 1)).structuredContent).created).toBe(true);
      expect(noteSchema.parse((await toolResultOf(child, 2)).structuredContent).created).toBe(true);

      // The refused call never reached the store, so its key is still unused.
      await child.send(createNote(4, "now accepted", THIRD_KEY));

      expect(noteSchema.parse((await toolResultOf(child, 4)).structuredContent).created).toBe(true);
      expect(await noteCount(dir)).toBe(3);
      child.endStdin();
      expect((await withinLimit(child.exited, "the server to exit")).code).toBe(EXIT_OK);
    });
  });
});

// Windows delivers no SIGINT or SIGTERM to a child: `kill()` there ends the process outright, so
// graceful signal handling cannot be exercised. Closing stdin (tested above) is the stop that works
// on every platform; these cases run wherever signals are real.
describe.skipIf(process.platform === "win32")("stop signals (POSIX)", () => {
  it.each([
    ["SIGINT", EXIT_INTERRUPTED],
    ["SIGTERM", EXIT_TERMINATED],
  ] as const)(
    "%s stops an idle server gracefully with the shell's exit code",
    async (signal, code) => {
      await withMcpChild(production({ DATA_DIR: await dataDirectory() }), async (child) => {
        await settle(child, 1);
        child.kill(signal);

        expect(await withinLimit(child.exited, "the server to stop")).toEqual({
          code,
          signal: null,
        });
        expect(child.strayStdout()).toEqual([]);
      });
    },
  );

  it("SIGTERM during a write aborts it, sends no response, and the write still commits", async () => {
    const dir = await dataDirectory();

    await withMcpChild(gated({ DATA_DIR: dir }), async (child) => {
      await startWrite(child, 1, "interrupted", KEY, 0);

      child.kill("SIGTERM");
      await child.whenIpc("write-aborted", 0);
      release(child, 0);
      await child.whenIpc("write-committed", 0);

      expect(await withinLimit(child.exited, "the server to stop")).toEqual({
        code: EXIT_TERMINATED,
        signal: null,
      });
      expect(child.responsesTo(1)).toEqual([]);
      expect(child.stdoutLines).toEqual([]);
    });

    expect(await noteCount(dir)).toBe(1);
  });
});
