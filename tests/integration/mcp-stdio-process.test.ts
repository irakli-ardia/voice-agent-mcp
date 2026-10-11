import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_OK,
  EXIT_USAGE,
} from "../../src/entrypoints/exit-codes.js";
import { CLI_ENTRY, type McpChild, withinLimit, withMcpChild } from "../helpers/mcp-child.js";
import { callToolRequest, modernRequest, toolResultOf } from "../helpers/mcp-wire.js";

/** The shipped command, run from source in a real process with real stdio and a real file store. */
const KEY = "stdio-caller-key-000001";

const OTHER_KEY = "stdio-caller-key-000002";

const SENTINEL = "SENTINEL-STDIO-8b3f21";

// Each test starts real processes through tsx, which takes a while on a slow machine.
vi.setConfig({ testTimeout: 60_000 });

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function dataDirectory(name = "mcp-stdio-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), name));

  directories.push(dir);

  return dir;
}

async function finish(child: McpChild): Promise<void> {
  child.endStdin();

  const { code } = await withinLimit(child.exited, "the server to exit after EOF");

  expect(code).toBe(EXIT_OK);
  expect(child.strayStdout()).toEqual([]);
}

function mcp(env: Readonly<Record<string, string>>, ...extra: readonly string[]) {
  return { entry: CLI_ENTRY, args: ["mcp", ...extra], env };
}

describe("voice-agent mcp: real process, modern protocol", () => {
  it("discovers, lists, calls, and exits 0 on EOF, with no OpenAI key and stdout purely protocol", async () => {
    const dir = await dataDirectory();

    await withMcpChild(mcp({ DATA_DIR: dir, OPENAI_API_KEY: "" }), async (child) => {
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
      // Only the executor's own structured event, once per call: nothing from the call's content.

      const events = child
        .stderrText()
        .split("\n")
        .filter(Boolean)
        .map((line) => z.object({ msg: z.string() }).parse(JSON.parse(line)).msg);

      expect(events).toEqual(["tool.completed"]);
    });
  });

  it("answers a request that arrives with no discovery first", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      await child.send(callToolRequest(1, "get_current_time", { timeZone: "Asia/Tokyo" }));

      expect((await toolResultOf(child, 1)).structuredContent).toMatchObject({
        timeZone: "Asia/Tokyo",
      });
      await finish(child);
    });
  });
});

describe("voice-agent mcp: real process, legacy protocol", () => {
  it("negotiates through initialize, then lists and calls, and exits 0 on EOF", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      await child.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-stdio-test", version: "0" },
        },
      });

      const initialized = z
        .object({
          result: z.object({
            protocolVersion: z.string(),
            capabilities: z.record(z.string(), z.json()),
            serverInfo: z.object({ name: z.string(), version: z.string() }),
          }),
        })
        .parse(await child.whenResponse(1));

      expect(initialized.result.protocolVersion).toBe("2025-11-25");
      expect(initialized.result.capabilities).toEqual({ tools: {} });
      expect(initialized.result.serverInfo.name).toBe("voice-agent-mcp");

      await child.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await child.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await child.send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "calculate", arguments: { operation: "multiply", a: 6, b: 7 } },
      });

      const listed = z
        .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse(await child.whenResponse(2));

      expect(listed.result.tools).toHaveLength(4);
      expect((await toolResultOf(child, 3)).structuredContent).toEqual({ result: 42 });
      await finish(child);
    });
  });

  it("reports an unknown method as a protocol error and keeps serving", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      await child.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "l", version: "0" },
        },
      });
      await child.whenResponse(1);
      await child.send({ jsonrpc: "2.0", id: 2, method: "no/such/method", params: {} });

      expect(
        z.object({ error: z.object({ code: z.number() }) }).parse(await child.whenResponse(2)).error
          .code,
      ).toBe(-32601);
      await finish(child);
    });
  });
});

describe("voice-agent mcp: what really crosses the wire", () => {
  it("writes each result as one line whose structuredContent and JSON text agree, including -0 and Unicode", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      const text = 'é 日本語 😀 "quoted" \n tab\t';

      await child.send(callToolRequest(1, "calculate", { operation: "multiply", a: 0, b: -1 }));
      await child.send(callToolRequest(2, "create_note", { text, idempotencyKey: KEY }));

      const zero = await toolResultOf(child, 1);
      const created = await toolResultOf(child, 2);
      const { noteId } = z.object({ noteId: z.string() }).parse(created.structuredContent);

      await child.send(callToolRequest(3, "read_note", { noteId }));

      const read = await toolResultOf(child, 3);

      // Negative zero is written as 0 by both representations, never as -0.
      expect(zero.structuredContent).toEqual({ result: 0 });
      expect(zero.content[0]?.text).toBe('{"result":0}');
      expect(child.stdoutLines.find((line) => line.includes('"id":1'))).not.toContain("-0");

      // Unicode and control characters survive both representations unchanged.
      expect(read.structuredContent).toMatchObject({ text });

      for (const result of [zero, created, read]) {
        expect(result.content).toHaveLength(1);
        expect(JSON.parse(result.content[0]?.text ?? "")).toStrictEqual(result.structuredContent);
      }

      expect(child.stdoutLines.every((line) => !line.includes("\n"))).toBe(true);
      await finish(child);
    });
  });

  it("preserves the caller's idempotencyKey: a replay is the same note, a changed payload a conflict", async () => {
    const dir = await dataDirectory();

    await withMcpChild(mcp({ DATA_DIR: dir }), async (child) => {
      // One request at a time: two concurrent writes of one key race for the file link, and which
      // of them reports created is then not defined. Concurrent same-key calls are tested elsewhere.
      const noteSchema = z.object({ noteId: z.string(), created: z.boolean() });

      await child.send(callToolRequest(1, "create_note", { text: "once", idempotencyKey: KEY }));

      const first = noteSchema.parse((await toolResultOf(child, 1)).structuredContent);

      await child.send(callToolRequest(2, "create_note", { text: "once", idempotencyKey: KEY }));

      const replay = noteSchema.parse((await toolResultOf(child, 2)).structuredContent);

      await child.send(callToolRequest(3, "create_note", { text: "other", idempotencyKey: KEY }));

      const conflict = await toolResultOf(child, 3);

      await child.send(
        callToolRequest(4, "create_note", { text: "once", idempotencyKey: OTHER_KEY }),
      );

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

    expect(await readdir(join(dir, "notes"))).toHaveLength(2);
  });

  it("answers an unknown tool with a static -32602 and invalid input with isError, echoing neither", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
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

  /** The byte size of a create_note result, measured from a first run of the real server. */
  async function measureCreateNoteResult(): Promise<number> {
    return withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      await child.send(
        callToolRequest(1, "create_note", { text: "size probe", idempotencyKey: KEY }),
      );

      const size = Buffer.byteLength((await toolResultOf(child, 1)).content[0]?.text ?? "", "utf8");

      await finish(child);

      return size;
    });
  }

  async function createNoteWithLimit(limit: number) {
    return withMcpChild(
      mcp({ DATA_DIR: await dataDirectory(), MAX_TOOL_RESULT_BYTES: String(limit) }),
      async (child) => {
        await child.send(
          callToolRequest(1, "create_note", { text: "size probe", idempotencyKey: KEY }),
        );

        const result = await toolResultOf(child, 1);

        await finish(child);

        return result;
      },
    );
  }

  it("returns a result exactly at the byte limit, whole and in both representations", async () => {
    const limit = await measureCreateNoteResult();
    const result = await createNoteWithLimit(limit);

    expect(result.isError).toBeUndefined();
    expect(Buffer.byteLength(result.content[0]?.text ?? "", "utf8")).toBe(limit);
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8")).toBe(limit);
  });

  it("refuses a result one byte over the limit, returning neither representation", async () => {
    const limit = await measureCreateNoteResult();
    const result = await createNoteWithLimit(limit - 1);

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe(
      "output_too_large: The tool result is too large to return.",
    );
    expect(result.structuredContent).toBeUndefined();
  });

  it("runs concurrent requests, each answered with its own result", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
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

describe("voice-agent mcp: transport limits and bad input", () => {
  it.each([1_048_577, 1_100_000, 3_000_000])(
    "fails with exit 1 on a %d-byte message, even with stdin still open, and says why safely",
    async (size) => {
      await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
        await child.sendRaw(
          `${SENTINEL.repeat(Math.ceil(size / SENTINEL.length)).slice(0, size)}\n`,
        );

        const { code, signal } = await withinLimit(
          child.exited,
          "the server to exit after an oversized message",
        );

        expect({ code, signal }).toEqual({ code: EXIT_FAILURE, signal: null });
        expect(child.stdoutLines).toEqual([]);
        expect(child.stdoutRemainder()).toBe("");

        const events = child
          .stderrText()
          .split("\n")
          .filter(Boolean)
          .map((line) => z.object({ msg: z.string() }).parse(JSON.parse(line)).msg);

        expect(events).toEqual(["mcp.transport_error", "mcp.stopped"]);
        expect(child.stderrText()).not.toContain(SENTINEL);
        expect(child.stderrText()).not.toMatch(/ReadBuffer|maximum size|bytes/i);
      });
    },
  );

  it("accepts a message just under the limit and answers it", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      await child.send(
        modernRequest(1, "tools/call", {
          name: "calculate",
          arguments: { operation: "add", a: 1, b: 2, padding: "p".repeat(1_048_576 - 2_000) },
        }),
      );

      expect((await toolResultOf(child, 1)).content[0]?.text).toMatch(/^invalid_input: /);
      await finish(child);
    });
  });

  it("survives malformed input and answers the request after it", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      await child.sendRaw(`this is not json ${SENTINEL}\n`);
      await child.sendRaw('{"jsonrpc":"2.0","id":"no-method"}\n');
      await child.send(callToolRequest(1, "calculate", { operation: "add", a: 1, b: 1 }));

      expect((await toolResultOf(child, 1)).structuredContent).toEqual({ result: 2 });
      await finish(child);
      expect(child.stderrText()).not.toContain(SENTINEL);
    });
  });

  it("sends no response to a request whose envelope is invalid, keeps serving, and echoes nothing", async () => {
    // SDK behaviour pinned: the transport drops a message whose `_meta` is malformed and reports
    // it, so that client gets no answer at all. A conforming client never sends one.
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      await child.sendRaw(
        `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"calculate","_meta":"${SENTINEL}"}}\n`,
      );
      await child.send(callToolRequest(2, "calculate", { operation: "add", a: 1, b: 1 }));

      expect((await toolResultOf(child, 2)).structuredContent).toEqual({ result: 2 });
      expect(child.responsesTo(1)).toEqual([]);
      await finish(child);
      expect(child.stderrText()).toContain("mcp.transport_error");
      expect(child.stderrText()).not.toContain(SENTINEL);
    });
  });
});

describe("voice-agent mcp: startup failures", () => {
  it("rejects invalid configuration with exit 78, on stderr only, without echoing the value", async () => {
    await withMcpChild(
      mcp({ DATA_DIR: await dataDirectory(), LOG_LEVEL: SENTINEL, MCP_MAX_IN_FLIGHT_CALLS: "0" }),
      async (child) => {
        const { code } = await withinLimit(child.exited, "the server to exit");

        expect(code).toBe(EXIT_CONFIG);
        expect(child.stdoutLines).toEqual([]);
        expect(child.stdoutRemainder()).toBe("");
        expect(child.stderrText()).toMatch(/^Invalid configuration:\n/);
        expect(child.stderrText()).toContain("MCP_MAX_IN_FLIGHT_CALLS");
        expect(child.stderrText()).not.toContain(SENTINEL);
      },
    );
  });

  it("rejects extra arguments with a usage error on stderr, and still lists the command in --help", async () => {
    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }, "--bogus"), async (child) => {
      const { code } = await withinLimit(child.exited, "the server to exit");

      expect(code).toBe(EXIT_USAGE);
      expect(child.stdoutLines).toEqual([]);
      expect(child.stderrText()).toMatch(/^error: usage: mcp takes no arguments/);
    });

    await withMcpChild({ entry: CLI_ENTRY, args: ["--help"] }, async (child) => {
      const { code } = await withinLimit(child.exited, "--help to finish");

      expect(code).toBe(EXIT_OK);
      expect(child.stdoutLines.join("\n")).toMatch(
        /\n {2}mcp {18}Serve the tools to an MCP client/,
      );
    });
  });

  it("leaves the other commands alone: tools lists the same four tools without a key", async () => {
    await withMcpChild({ entry: CLI_ENTRY, args: ["tools"] }, async (child) => {
      const { code } = await withinLimit(child.exited, "tools to finish");

      expect(code).toBe(EXIT_OK);
      expect(child.stdoutLines.map((line) => line.split(" ")[0])).toEqual([
        "get_current_time",
        "calculate",
        "create_note",
        "read_note",
      ]);
    });
  });
});

describe("voice-agent mcp: privacy over the real streams", () => {
  it("keeps secrets out of stderr and out of every response that should not carry them", async () => {
    const dir = await dataDirectory(`${SENTINEL}-dir-`);

    await withMcpChild(mcp({ DATA_DIR: dir, LOG_LEVEL: "trace" }), async (child) => {
      await child.send(
        callToolRequest(1, "create_note", {
          text: `note ${SENTINEL}`,
          idempotencyKey: `${SENTINEL}-KEY-0001`,
        }),
      );
      await child.send(
        callToolRequest(2, "create_note", {
          text: `note ${SENTINEL}`,
          idempotencyKey: `${SENTINEL}-KEY-0001`.slice(0, 10),
        }),
      );
      await child.send(callToolRequest(3, `unknown-${SENTINEL}`, { [SENTINEL]: SENTINEL }));
      await child.send(
        callToolRequest(4, "calculate", { operation: SENTINEL, a: SENTINEL, b: SENTINEL }),
      );
      await child.whenResponse(4);
      await finish(child);

      expect(child.stderrText().length).toBeGreaterThan(0);
      expect(child.stderrText()).not.toContain(SENTINEL);
      expect(child.stdoutLines.join("\n")).not.toContain(SENTINEL);
      expect(child.stdoutLines.join("\n")).not.toContain(dir);
    });
  });

  it("reports a storage failure statically, without the path, in the response or the log", async () => {
    const dir = await dataDirectory(`${SENTINEL}-store-`);

    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes"), "a file where the notes directory belongs");

    await withMcpChild(mcp({ DATA_DIR: dir, LOG_LEVEL: "trace" }), async (child) => {
      await child.send(callToolRequest(1, "create_note", { text: "unsaved", idempotencyKey: KEY }));

      const failed = await toolResultOf(child, 1);

      expect(failed.isError).toBe(true);
      expect(failed.content[0]?.text).toMatch(/^execution_failed: The note store is unavailable/);
      expect(child.stderrText()).toContain("note_store.unavailable");
      expect(child.stderrText()).not.toContain(SENTINEL);
      expect(child.stdoutLines.join("\n")).not.toContain(SENTINEL);
      await finish(child);
    });
  });
});

describe("voice-agent mcp: process cleanup", () => {
  it("leaves no process behind after the connection ends", async () => {
    let pid: number | undefined;

    await withMcpChild(mcp({ DATA_DIR: await dataDirectory() }), async (child) => {
      pid = child.pid;
      await finish(child);
    });

    expect(pid).toBeDefined();
    expect(() => process.kill(pid ?? 0, 0)).toThrow("ESRCH");
  });
});
