import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { COMMAND_SHUTDOWN_BOUND_MS } from "../../../src/entrypoints/interrupt.js";

/**
 * SG5 acceptance for `ask`, in a real process: `ask` with a scripted model, the real shutdown glue,
 * CLI, agent runner, executor, `create_note` tool and file store, a signal arriving while the note
 * write is past its commit point. Signals can be sent only on POSIX; the control run works anywhere.
 */
const HARNESS = join(import.meta.dirname, "..", "..", "helpers", "ask-note-child.mjs");

const SIGNALS_WORK = process.platform !== "win32";

const HEADROOM_MS = 5_000;

let data: string;

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "mcp-dist-ask-note-"));
});

afterEach(async () => {
  await rm(data, { recursive: true, force: true });
});

interface Run {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly held: Promise<void>;
  readonly exit: Promise<{ code: number | null; at: number }>;
}

function start(hold: "release" | "never" | "none"): Run {
  const child = spawn(process.execPath, [HARNESS, hold], {
    env: { ...getDefaultEnvironment(), DATA_DIR: data, OPENAI_API_KEY: "sk-not-a-real-key" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const held = new Promise<void>((resolve) => {
    child.stdout?.on("data", (chunk: string) => {
      if (chunk.includes("HELD")) {
        resolve();
      }
    });
  });

  const exit = new Promise<{ code: number | null; at: number }>((resolve) => {
    child.on("exit", (code) => resolve({ code, at: Date.now() }));
  });

  return { child, stdout: () => stdout, stderr: () => stderr, held, exit };
}

const noteSchema = z.object({ noteId: z.string(), text: z.string() }).loose();

/** Every published note parses: none is torn or unreadable. */
async function publishedNotes(): Promise<number> {
  const names = (await readdir(join(data, "notes")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  );

  for (const name of names) {
    noteSchema.parse(JSON.parse(await readFile(join(data, "notes", name), "utf8")));
  }

  return names.length;
}

describe("ask with a note write past its commit point, built distribution", () => {
  it("control: no signal, the turn completes, one note, exit 0", async () => {
    const run = start("none");
    const ended = await run.exit;

    expect(ended.code).toBe(0);
    expect(run.stdout()).toContain("saved");
    expect(await publishedNotes()).toBe(1);
  });

  it.runIf(SIGNALS_WORK)(
    "SIGINT: the turn is cancelled with 130, the write still commits, one whole note",
    async () => {
      const run = start("release");

      await run.held;

      const sentAt = Date.now();

      run.child.kill("SIGINT");

      const ended = await run.exit;

      expect(ended.code).toBe(130);
      expect(ended.at - sentAt).toBeLessThan(COMMAND_SHUTDOWN_BOUND_MS);
      expect(run.stderr()).toContain("cancelled");
      expect(await publishedNotes()).toBe(1);
      expect(await readdir(join(data, "note-slots"))).toContain("0");
    },
  );

  it.runIf(SIGNALS_WORK)("SIGTERM: the same, with 143", async () => {
    const run = start("release");

    await run.held;
    run.child.kill("SIGTERM");

    expect((await run.exit).code).toBe(143);
    expect(await publishedNotes()).toBe(1);
  });

  it.runIf(SIGNALS_WORK)(
    "a write that never finishes: ended at the bound with 130, at most one note, none torn",
    async () => {
      const run = start("never");

      await run.held;

      const sentAt = Date.now();

      run.child.kill("SIGINT");

      const ended = await run.exit;

      expect(ended.code).toBe(130);
      expect(ended.at - sentAt).toBeGreaterThanOrEqual(COMMAND_SHUTDOWN_BOUND_MS - 300);
      expect(ended.at - sentAt).toBeLessThan(COMMAND_SHUTDOWN_BOUND_MS + HEADROOM_MS);
      expect(await publishedNotes()).toBeLessThanOrEqual(1);
    },
  );
});
