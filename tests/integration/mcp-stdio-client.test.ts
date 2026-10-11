import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CLI_ENTRY, withinLimit } from "../helpers/mcp-child.js";

/**
 * The official SDK client driving the shipped command over real stdio, once in each protocol era.
 * A pinned modern client fails to connect if the server does not speak that era, so connecting is
 * itself the proof; the default client uses the legacy `initialize` handshake.
 */
vi.setConfig({ testTimeout: 60_000 });

const directories: string[] = [];

const open: Client[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map(async (client) => client.close().catch(() => undefined)));
  await Promise.all(
    directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

type Era = "legacy" | "modern";

const noteSchema = z.object({ noteId: z.string(), created: z.boolean() });

async function connect(era: Era) {
  const dir = await mkdtemp(join(tmpdir(), "mcp-stdio-client-"));

  directories.push(dir);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", CLI_ENTRY, "mcp"],
    cwd: join(import.meta.dirname, "..", ".."),
    env: { ...getDefaultEnvironment(), DATA_DIR: dir },
    stderr: "ignore",
  });

  const info = { name: "official-client-test", version: "0.0.0" };

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

describe.each<Era>(["legacy", "modern"])("the official client over real stdio, %s era", (era) => {
  it("connects, sees the server's identity and only the tools capability", async () => {
    const { client } = await connect(era);

    expect(client.getServerVersion()).toMatchObject({ name: "voice-agent-mcp" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
  });

  it("lists the four canonical tools in order, with their annotations and the idempotencyKey", async () => {
    const { client } = await connect(era);
    const listed = await withinLimit(client.listTools(), "tools/list");

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "get_current_time",
      "calculate",
      "create_note",
      "read_note",
    ]);

    const createNote = listed.tools.find((tool) => tool.name === "create_note");

    expect(createNote?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(createNote?.inputSchema).toHaveProperty("properties.idempotencyKey");
  });

  it("calls tools: a result, a tool error, an unknown tool, and a keyed write that replays", async () => {
    const { client } = await connect(era);

    const sum = await client.callTool({
      name: "calculate",
      arguments: { operation: "add", a: 20, b: 22 },
    });

    expect(sum.structuredContent).toEqual({ result: 42 });

    const invalid = await client.callTool({ name: "calculate", arguments: { operation: "add" } });

    expect(invalid.isError).toBe(true);

    const unknown = await client.callTool({ name: "no_such_tool", arguments: {} }).then(
      () => "resolved",
      (error: Error) => error.message,
    );

    expect(unknown).toBe("No tool with this name exists.");

    const args = { text: "official client", idempotencyKey: "official-client-key-0001" };
    const first = await client.callTool({ name: "create_note", arguments: args });
    const replay = await client.callTool({ name: "create_note", arguments: args });

    expect(noteSchema.parse(first.structuredContent).created).toBe(true);
    expect(noteSchema.parse(replay.structuredContent)).toEqual({
      noteId: noteSchema.parse(first.structuredContent).noteId,
      created: false,
    });
  });

  it("answers concurrent calls, each with its own result", async () => {
    const { client } = await connect(era);

    const results = await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) =>
        client.callTool({ name: "calculate", arguments: { operation: "add", a: index, b: 1000 } }),
      ),
    );

    expect(results.map((result) => result.structuredContent)).toEqual(
      Array.from({ length: 8 }, (_unused, index) => ({ result: index + 1000 })),
    );
  });

  it("shuts down cleanly when the client closes: the server process is gone", async () => {
    const { client, pid } = await connect(era);

    await client.callTool({ name: "get_current_time", arguments: { timeZone: null } });
    await withinLimit(client.close(), "the client to close");

    expect(pid).not.toBeNull();
    await vi.waitFor(() => expect(() => process.kill(pid ?? 0, 0)).toThrow("ESRCH"));
  });
});
