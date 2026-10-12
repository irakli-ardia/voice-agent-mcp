import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DIST_CLI_ENTRY,
  GATED_WRITE_ENTRY,
  type McpChild,
  runtimeArguments,
  withinLimit,
  withMcpChild,
} from "../../helpers/mcp-child.js";
import {
  callToolRequest,
  cancelNotification,
  modernRequest,
  toolResultOf,
} from "../../helpers/mcp-wire.js";

/**
 * The built distribution: `node dist/entrypoints/voice-agent.js mcp` as a user runs it, in real
 * child processes started by plain `node` (no tsx, no TypeScript) from a working directory outside
 * the repository. Nothing here uses an in-memory transport. The exit codes are written out as
 * numbers on purpose: they are part of the documented contract, so they are not imported.
 */
const EXIT = {
  ok: 0,
  failure: 1,
  usage: 64,
  config: 78,
  interrupted: 130,
  terminated: 143,
} as const;

const KEY = "dist-caller-key-0000001";

const OTHER_KEY = "dist-caller-key-0000002";

const THIRD_KEY = "dist-caller-key-0000003";

const SENTINEL = "SENTINEL-DIST-5e7a19";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = "mcp-dist-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));

  directories.push(dir);

  return dir;
}

interface Workspace {
  readonly data: string;
  readonly cwd: string;
}

async function workspace(): Promise<Workspace> {
  return {
    data: await temporaryDirectory("mcp-dist-data-"),
    cwd: await temporaryDirectory("mcp-dist-cwd-"),
  };
}

function cli(
  space: Workspace,
  env: Readonly<Record<string, string>> = {},
  ...extra: readonly string[]
) {
  return {
    entry: DIST_CLI_ENTRY,
    compiled: true,
    args: ["mcp", ...extra],
    cwd: space.cwd,
    env: { DATA_DIR: space.data, ...env },
  };
}

function gatedServer(space: Workspace, env: Readonly<Record<string, string>> = {}) {
  return {
    entry: GATED_WRITE_ENTRY,
    compiled: true,
    args: ["dist"],
    cwd: space.cwd,
    env: { DATA_DIR: space.data, ...env },
  };
}

async function notesIn(dir: string): Promise<number> {
  return (await readdir(join(dir, "notes")).catch(() => [])).length;
}

async function finish(child: McpChild): Promise<void> {
  child.endStdin();

  const { code } = await withinLimit(child.exited, "the server to exit after EOF");

  expect(code).toBe(EXIT.ok);
  expect(child.strayStdout()).toEqual([]);
}

const noteSchema = z.object({ noteId: z.string(), created: z.boolean() });

const eventSchema = z.object({ msg: z.string() });

function logEvents(child: McpChild): readonly string[] {
  return child
    .stderrText()
    .split("\n")
    .filter(Boolean)
    .map((line) => eventSchema.parse(JSON.parse(line)).msg);
}

function createNote(id: number, text: string, idempotencyKey: string) {
  return callToolRequest(id, "create_note", { text, idempotencyKey });
}

describe("the compiled distribution", () => {
  it("is JavaScript that plain node runs: a shebang, no loader, no TypeScript reference", () => {
    const text = readFileSync(DIST_CLI_ENTRY, "utf8");

    expect(existsSync(DIST_CLI_ENTRY)).toBe(true);
    expect(text.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(runtimeArguments(true)).toEqual([]);
    // The sources run through the tsx loader, named by absolute URL so any working directory finds it.
    expect(runtimeArguments(false)).toEqual([
      "--import",
      expect.stringMatching(/^file:\/\/.*\/node_modules\/tsx\/dist\/esm\/index\.mjs$/),
    ]);
    expect(text).not.toMatch(/\.ts["']/);
  });
});

describe("node dist/entrypoints/voice-agent.js mcp: modern protocol", () => {
  it("starts without an OpenAI key, discovers, lists, calls, and exits 0 on EOF", async () => {
    const space = await workspace();

    await withMcpChild(cli(space), async (child) => {
      await child.send(modernRequest(1, "server/discover"));
      await child.send(modernRequest(2, "tools/list"));
      await child.send(callToolRequest(3, "calculate", { operation: "add", a: 2, b: 3 }));

      const discover = z
        .object({ result: z.object({ supportedVersions: z.array(z.string()) }) })
        .parse(await child.whenResponse(1));

      const listed = z
        .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse(await child.whenResponse(2));

      const sum = await toolResultOf(child, 3);

      expect(discover.result.supportedVersions).toContain("2026-07-28");
      expect(listed.result.tools.map((tool) => tool.name)).toEqual([
        "get_current_time",
        "calculate",
        "create_note",
        "read_note",
      ]);
      expect(sum.structuredContent).toEqual({ result: 5 });
      expect(JSON.parse(sum.content[0]?.text ?? "")).toStrictEqual(sum.structuredContent);
      await finish(child);

      // stderr carries the executor's own event only, one per call, and nothing from its content.
      expect(logEvents(child)).toEqual(["tool.completed"]);
    });
  });
});

describe("node dist/entrypoints/voice-agent.js mcp: legacy protocol", () => {
  it("negotiates through initialize, then lists and calls", async () => {
    await withMcpChild(cli(await workspace()), async (child) => {
      await child.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-dist-test", version: "0" },
        },
      });

      const initialized = z
        .object({
          result: z.object({
            protocolVersion: z.string(),
            capabilities: z.record(z.string(), z.json()),
          }),
        })
        .parse(await child.whenResponse(1));

      expect(initialized.result).toEqual({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
      });
      await child.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await child.send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "calculate", arguments: { operation: "multiply", a: 6, b: 7 } },
      });

      expect((await toolResultOf(child, 2)).structuredContent).toEqual({ result: 42 });
      await finish(child);
    });
  });
});

describe("the official SDK client over the compiled command", () => {
  const open: Client[] = [];

  afterEach(async () => {
    await Promise.all(open.splice(0).map(async (client) => client.close().catch(() => undefined)));
  });

  async function connect(era: "legacy" | "modern") {
    const space = await workspace();

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DIST_CLI_ENTRY, "mcp"],
      cwd: space.cwd,
      env: { ...getDefaultEnvironment(), DATA_DIR: space.data },
      stderr: "ignore",
    });

    const info = { name: "official-client-dist-test", version: "0.0.0" };

    const client =
      era === "modern"
        ? new Client(info, {
            capabilities: {},
            versionNegotiation: { mode: { pin: "2026-07-28" } },
          })
        : new Client(info, { capabilities: {} });

    open.push(client);
    await withinLimit(client.connect(transport), `the ${era} client to connect`);

    return { client, pid: transport.pid };
  }

  it.each(["legacy", "modern"] as const)(
    "%s era: lists, calls, replays a keyed write, and shuts down cleanly",
    async (era) => {
      const { client, pid } = await connect(era);
      const listed = await withinLimit(client.listTools(), "tools/list");

      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "get_current_time",
        "calculate",
        "create_note",
        "read_note",
      ]);
      expect(listed.tools.find((tool) => tool.name === "create_note")?.inputSchema).toHaveProperty(
        "properties.idempotencyKey",
      );

      const sum = await client.callTool({
        name: "calculate",
        arguments: { operation: "add", a: 20, b: 22 },
      });

      const args = { text: "dist client", idempotencyKey: KEY };

      const first = noteSchema.parse(
        (await client.callTool({ name: "create_note", arguments: args })).structuredContent,
      );

      const replay = noteSchema.parse(
        (await client.callTool({ name: "create_note", arguments: args })).structuredContent,
      );

      expect(sum.structuredContent).toEqual({ result: 42 });
      expect(first.created).toBe(true);
      expect(replay).toEqual({ noteId: first.noteId, created: false });

      await withinLimit(client.close(), "the client to close");
      await vi.waitFor(() => expect(() => process.kill(pid ?? 0, 0)).toThrow("ESRCH"));
    },
  );
});

describe("what the compiled server really writes", () => {
  it("keeps structuredContent and text in agreement, writing -0 as 0 and Unicode unchanged", async () => {
    await withMcpChild(cli(await workspace()), async (child) => {
      const text = 'é 日本語 😀 "quoted" \n tab\t';

      await child.send(callToolRequest(1, "calculate", { operation: "multiply", a: 0, b: -1 }));
      await child.send(createNote(2, text, KEY));

      const zero = await toolResultOf(child, 1);
      const created = await toolResultOf(child, 2);
      const { noteId } = noteSchema.parse(created.structuredContent);

      await child.send(callToolRequest(3, "read_note", { noteId }));

      const read = await toolResultOf(child, 3);

      expect(zero.content[0]?.text).toBe('{"result":0}');
      expect(child.stdoutLines.find((line) => line.includes('"id":1'))).not.toContain("-0");
      expect(read.structuredContent).toMatchObject({ text });

      for (const result of [zero, created, read]) {
        expect(result.content).toHaveLength(1);
        expect(JSON.parse(result.content[0]?.text ?? "")).toStrictEqual(result.structuredContent);
      }

      await finish(child);
    });
  });

  it("preserves the caller's idempotencyKey: replay, conflict, and a distinct key", async () => {
    const space = await workspace();

    await withMcpChild(cli(space), async (child) => {
      await child.send(createNote(1, "once", KEY));

      const first = noteSchema.parse((await toolResultOf(child, 1)).structuredContent);

      await child.send(createNote(2, "once", KEY));

      const replay = noteSchema.parse((await toolResultOf(child, 2)).structuredContent);

      await child.send(createNote(3, "other", KEY));

      const conflict = await toolResultOf(child, 3);

      await child.send(createNote(4, "once", OTHER_KEY));

      const distinct = noteSchema.parse((await toolResultOf(child, 4)).structuredContent);

      expect(first.created).toBe(true);
      expect(replay).toEqual({ noteId: first.noteId, created: false });
      expect(conflict.isError).toBe(true);
      expect(conflict.content[0]?.text).toMatch(
        /^execution_failed: This idempotency key was already used/,
      );
      expect(distinct.noteId).not.toBe(first.noteId);
      await finish(child);
    });

    expect(await notesIn(space.data)).toBe(2);
  });

  it("rejects a missing or malformed key as invalid input before anything is written", async () => {
    const space = await workspace();

    await withMcpChild(cli(space), async (child) => {
      await child.send(callToolRequest(1, "create_note", { text: "no key" }));
      await child.send(
        callToolRequest(2, "create_note", { text: "short", idempotencyKey: "short" }),
      );

      for (const id of [1, 2]) {
        const result = await toolResultOf(child, id);

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toMatch(/^invalid_input: .*idempotencyKey/);
      }

      await finish(child);
    });

    expect(await notesIn(space.data)).toBe(0);
  });

  it("answers an unknown tool with a static -32602 and invalid input with isError, echoing neither", async () => {
    await withMcpChild(cli(await workspace()), async (child) => {
      await child.send(callToolRequest(1, `no such tool ${SENTINEL}`, {}));
      await child.send(
        callToolRequest(2, "calculate", { operation: SENTINEL, a: SENTINEL, b: 1, [SENTINEL]: 1 }),
      );

      const unknown = z
        .object({ error: z.object({ code: z.number(), message: z.string() }) })
        .parse(await child.whenResponse(1));

      const invalid = await toolResultOf(child, 2);

      expect(unknown.error).toEqual({ code: -32602, message: "No tool with this name exists." });
      expect(invalid.isError).toBe(true);
      expect(invalid.content[0]?.text).toMatch(/^invalid_input: /);
      expect(child.stdoutLines.join("\n")).not.toContain(SENTINEL);
      await finish(child);
    });
  });

  async function createNoteWithLimit(limit: number) {
    return withMcpChild(
      cli(await workspace(), { MAX_TOOL_RESULT_BYTES: String(limit) }),
      async (child) => {
        await child.send(createNote(1, "size probe", KEY));

        const result = await toolResultOf(child, 1);

        await finish(child);

        return result;
      },
    );
  }

  it("holds a result to the byte limit exactly: at it passes, one byte under refuses", async () => {
    const probe = await createNoteWithLimit(16_384);
    const size = Buffer.byteLength(probe.content[0]?.text ?? "", "utf8");
    const atLimit = await createNoteWithLimit(size);
    const under = await createNoteWithLimit(size - 1);

    expect(atLimit.isError).toBeUndefined();
    expect(Buffer.byteLength(atLimit.content[0]?.text ?? "", "utf8")).toBe(size);
    expect(under.isError).toBe(true);
    expect(under.content[0]?.text).toBe(
      "output_too_large: The tool result is too large to return.",
    );
    expect(under.structuredContent).toBeUndefined();
  });

  it("runs concurrent requests, each answered with its own result", async () => {
    await withMcpChild(cli(await workspace()), async (child) => {
      for (let id = 1; id <= 12; id += 1) {
        await child.send(callToolRequest(id, "calculate", { operation: "add", a: id, b: 100 }));
      }

      for (let id = 1; id <= 12; id += 1) {
        expect((await toolResultOf(child, id)).structuredContent).toEqual({ result: id + 100 });
      }

      await finish(child);
    });
  });
});

describe("failures of the compiled command", () => {
  it.each([1_048_577, 1_100_000, 3_000_000])(
    "exits 1 on a %d-byte message with stdin still open: stdout empty, stderr safe",
    async (size) => {
      await withMcpChild(cli(await workspace()), async (child) => {
        await child.sendRaw(
          `${SENTINEL.repeat(Math.ceil(size / SENTINEL.length)).slice(0, size)}\n`,
        );

        const exit = await withinLimit(
          child.exited,
          "the server to exit after an oversized message",
        );

        expect(exit).toEqual({ code: EXIT.failure, signal: null });
        expect(child.stdoutLines).toEqual([]);
        expect(child.stdoutRemainder()).toBe("");
        expect(logEvents(child)).toEqual(["mcp.transport_error", "mcp.stopped"]);
        expect(child.stderrText()).not.toContain(SENTINEL);
        expect(child.stderrText()).not.toMatch(/ReadBuffer|maximum size|bytes/i);
      });
    },
  );

  it("accepts a message just under the limit and survives malformed input", async () => {
    await withMcpChild(cli(await workspace()), async (child) => {
      await child.sendRaw(`this is not json ${SENTINEL}\n`);
      await child.send(
        modernRequest(1, "tools/call", {
          name: "calculate",
          arguments: { operation: "add", a: 1, b: 2, padding: "p".repeat(1_048_576 - 2_000) },
        }),
      );
      await child.send(callToolRequest(2, "calculate", { operation: "add", a: 1, b: 1 }));

      expect((await toolResultOf(child, 1)).content[0]?.text).toMatch(/^invalid_input: /);
      expect((await toolResultOf(child, 2)).structuredContent).toEqual({ result: 2 });
      await finish(child);
      expect(child.stderrText()).not.toContain(SENTINEL);
    });
  });

  it("rejects invalid configuration with exit 78 on stderr only, without echoing the value", async () => {
    await withMcpChild(
      cli(await workspace(), { LOG_LEVEL: SENTINEL, MCP_MAX_IN_FLIGHT_CALLS: "0" }),
      async (child) => {
        const { code } = await withinLimit(child.exited, "the server to exit");

        expect(code).toBe(EXIT.config);
        expect(child.stdoutLines).toEqual([]);
        expect(child.stdoutRemainder()).toBe("");
        expect(child.stderrText()).toMatch(/^Invalid configuration:\n/);
        expect(child.stderrText()).toContain("MCP_MAX_IN_FLIGHT_CALLS");
        expect(child.stderrText()).not.toContain(SENTINEL);
      },
    );
  });

  it("rejects extra arguments with exit 64 on stderr, and leaves other commands alone", async () => {
    const space = await workspace();

    await withMcpChild(cli(space, {}, "--bogus"), async (child) => {
      expect((await withinLimit(child.exited, "the server to exit")).code).toBe(EXIT.usage);
      expect(child.stdoutLines).toEqual([]);
      expect(child.stderrText()).toMatch(/^error: usage: mcp takes no arguments/);
    });

    await withMcpChild(
      { entry: DIST_CLI_ENTRY, compiled: true, args: ["tools"], cwd: space.cwd, env: {} },
      async (child) => {
        expect((await withinLimit(child.exited, "tools to finish")).code).toBe(EXIT.ok);
        expect(child.stdoutLines.map((line) => line.split(" ")[0])).toEqual([
          "get_current_time",
          "calculate",
          "create_note",
          "read_note",
        ]);
      },
    );
  });

  it("keeps secrets out of stderr and stdout, including the data directory's name", async () => {
    const data = await temporaryDirectory(`${SENTINEL}-data-`);
    const cwd = await temporaryDirectory();

    await withMcpChild(
      {
        entry: DIST_CLI_ENTRY,
        compiled: true,
        args: ["mcp"],
        cwd,
        env: { DATA_DIR: data, LOG_LEVEL: "trace" },
      },
      async (child) => {
        await child.send(createNote(1, `note ${SENTINEL}`, `${SENTINEL}-KEY-0001`));
        await child.send(callToolRequest(2, `unknown-${SENTINEL}`, { [SENTINEL]: SENTINEL }));
        await child.send(
          callToolRequest(3, "calculate", { operation: SENTINEL, a: SENTINEL, b: SENTINEL }),
        );
        await child.whenResponse(3);
        await finish(child);

        expect(child.stderrText().length).toBeGreaterThan(0);
        expect(child.stderrText()).not.toContain(SENTINEL);
        expect(child.stdoutLines.join("\n")).not.toContain(SENTINEL);
      },
    );
  });
});

describe("side effects in the compiled server (controllable writes)", () => {
  function release(child: McpChild, ...indexes: readonly number[]): void {
    for (const index of indexes) {
      child.sendIpc({ type: "release", index });
    }
  }

  async function startWrite(child: McpChild, id: number, text: string, key: string, index: number) {
    await child.send(createNote(id, text, key));
    await child.whenIpc("write-entered", index);
  }

  it("cancels only the cancelled write, answers the other, and a retry of the cancelled key replays", async () => {
    const space = await workspace();

    await withMcpChild(gatedServer(space), async (child) => {
      await startWrite(child, 1, "cancelled", KEY, 0);
      await startWrite(child, 2, "survivor", OTHER_KEY, 1);

      await child.send(cancelNotification(1));
      await child.whenIpc("write-aborted", 0);
      expect(child.ipc.filter(({ type }) => type === "write-aborted")).toHaveLength(1);

      release(child, 1, 0, 2);
      await child.whenIpc("write-committed", 0);
      await child.whenIpc("write-committed", 1);
      expect(noteSchema.parse((await toolResultOf(child, 2)).structuredContent).created).toBe(true);

      // A later request was answered, so an answer owed to request 1 would be out by now.
      await child.send(modernRequest(3, "tools/list"));
      await child.whenResponse(3);
      expect(child.responsesTo(1)).toEqual([]);

      await child.send(createNote(4, "cancelled", KEY));
      expect(noteSchema.parse((await toolResultOf(child, 4)).structuredContent).created).toBe(
        false,
      );
      expect(await notesIn(space.data)).toBe(2);
      await finish(child);
    });
  });

  it("on stdin EOF mid-write: aborts, sends nothing, commits, exits 0, and a retry writes nothing new", async () => {
    const space = await workspace();

    await withMcpChild(gatedServer(space), async (child) => {
      await startWrite(child, 1, "written after EOF", KEY, 0);
      child.endStdin();
      await child.whenIpc("write-aborted", 0);
      expect(child.stdoutLines).toEqual([]);

      release(child, 0);
      await child.whenIpc("write-committed", 0);

      expect(await withinLimit(child.exited, "the server to exit after EOF")).toEqual({
        code: EXIT.ok,
        signal: null,
      });
      expect(child.stdoutLines).toEqual([]);
      expect(child.responsesTo(1)).toEqual([]);
    });

    expect(await notesIn(space.data)).toBe(1);

    await withMcpChild(cli(space), async (retry) => {
      await retry.send(createNote(1, "written after EOF", KEY));
      expect(noteSchema.parse((await toolResultOf(retry, 1)).structuredContent).created).toBe(
        false,
      );
      await finish(retry);
    });

    expect(await notesIn(space.data)).toBe(1);
  });

  it("refuses calls over MCP_MAX_IN_FLIGHT_CALLS with server_busy, and does not consume the refused key", async () => {
    const space = await workspace();

    await withMcpChild(gatedServer(space, { MCP_MAX_IN_FLIGHT_CALLS: "2" }), async (child) => {
      await startWrite(child, 1, "first", KEY, 0);
      await startWrite(child, 2, "second", OTHER_KEY, 1);
      await child.send(createNote(3, "refused", THIRD_KEY));

      const refused = await toolResultOf(child, 3);

      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toBe(
        "server_busy: Too many tool calls are in flight; retry later.",
      );
      expect(child.ipc.filter(({ type }) => type === "write-entered")).toHaveLength(2);

      release(child, 0, 1, 2);
      await toolResultOf(child, 1);
      await toolResultOf(child, 2);
      await child.send(createNote(4, "now accepted", THIRD_KEY));
      expect(noteSchema.parse((await toolResultOf(child, 4)).structuredContent).created).toBe(true);
      expect(await notesIn(space.data)).toBe(3);
      await finish(child);
    });
  });
});

// Windows delivers no SIGINT or SIGTERM to a child process, so graceful signal handling is only
// observable where signals are real; closing stdin (above) is the stop that works everywhere.
describe.skipIf(process.platform === "win32")("stop signals (POSIX)", () => {
  it.each([
    ["SIGINT", EXIT.interrupted],
    ["SIGTERM", EXIT.terminated],
  ] as const)(
    "%s stops an idle compiled server with the shell's exit code",
    async (signal, code) => {
      await withMcpChild(cli(await workspace()), async (child) => {
        await child.send(modernRequest(1, "tools/list"));
        await child.whenResponse(1);
        child.kill(signal);

        expect(await withinLimit(child.exited, "the server to stop")).toEqual({
          code,
          signal: null,
        });
        expect(child.strayStdout()).toEqual([]);
      });
    },
  );
});

describe("process cleanup", () => {
  it("leaves no process behind after the connection ends", async () => {
    let pid: number | undefined;

    await withMcpChild(cli(await workspace()), async (child) => {
      pid = child.pid;
      await finish(child);
    });

    expect(pid).toBeDefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow("ESRCH");
  });
});
