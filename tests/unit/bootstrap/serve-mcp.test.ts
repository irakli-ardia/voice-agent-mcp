import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  serveMcp,
} from "../../../src/bootstrap/serve-mcp.js";
import type { JsonObject } from "../../../src/domain/json-value.js";
import { testConfig } from "../../helpers/test-config.js";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function application() {
  return createApplication(testConfig({ dataDir: "serve-mcp-test-never-written" }));
}

/** The server on plain streams, with everything it writes to stdout kept as lines. */
function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const lines: string[] = [];
  let pending = "";

  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    pending += chunk;

    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      lines.push(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });

  return {
    stdin,
    stdout,
    lines,
    send: (message: JsonObject): void => {
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    whenLines: async (count: number): Promise<void> =>
      vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(count)),
  };
}

function toolsListRequest(id: number) {
  return { jsonrpc: "2.0", id, method: "tools/list", params: { _meta: MODERN_META } };
}

describe("serveMcp", () => {
  it("reports the package's own name and version", () => {
    const manifest = z
      .object({ name: z.string(), version: z.string() })
      .parse(
        JSON.parse(
          readFileSync(join(import.meta.dirname, "..", "..", "..", "package.json"), "utf8"),
        ),
      );

    expect(MCP_SERVER_NAME).toBe(manifest.name);
    expect(MCP_SERVER_VERSION).toBe(manifest.version);
  });

  it("limits one inbound message to 1 MiB", () => {
    expect(MCP_MAX_MESSAGE_BYTES).toBe(1_048_576);
  });

  it("ends with closed when the client closes stdin, and writes nothing on its own", async () => {
    const io = streams();
    const ended = serveMcp(application(), { ...io, signal: new AbortController().signal });

    io.stdin.end();

    expect(await ended).toBe("closed");
    expect(io.lines).toEqual([]);
  });

  it("serves the modern era, answering a request with one JSON-RPC line", async () => {
    const io = streams();
    const ended = serveMcp(application(), { ...io, signal: new AbortController().signal });

    io.send(toolsListRequest(1));
    await io.whenLines(1);
    io.stdin.end();

    expect(await ended).toBe("closed");
    expect(io.lines).toHaveLength(1);
    expect(JSON.parse(io.lines[0] ?? "")).toMatchObject({ jsonrpc: "2.0", id: 1 });
  });

  it("serves the legacy era through initialize", async () => {
    const io = streams();
    const ended = serveMcp(application(), { ...io, signal: new AbortController().signal });

    io.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "legacy", version: "0" },
      },
    });
    await io.whenLines(1);
    io.stdin.end();
    await ended;

    expect(JSON.parse(io.lines[0] ?? "")).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-11-25", serverInfo: { name: MCP_SERVER_NAME } },
    });
  });

  it("builds a server per connection from the one application, adding no listeners of its own", async () => {
    const before = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].map((event) =>
      process.listenerCount(event),
    );

    const io = streams();
    const ended = serveMcp(application(), { ...io, signal: new AbortController().signal });

    // A discovery probe makes the SDK build a server it then discards when a legacy client arrives.
    io.send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: MODERN_META } });
    await io.whenLines(1);
    io.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "l", version: "0" },
      },
    });
    await io.whenLines(2);
    expect(io.stdin.listenerCount("data")).toBe(1);

    io.stdin.end();
    await ended;

    expect(io.stdin.listenerCount("data")).toBe(0);
    expect(
      ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"].map((event) =>
        process.listenerCount(event),
      ),
    ).toEqual(before);
  });

  it("treats a message over the limit as a failure, with nothing on stdout", async () => {
    const io = streams();
    const ended = serveMcp(application(), { ...io, signal: new AbortController().signal });

    io.stdin.write(`${"x".repeat(MCP_MAX_MESSAGE_BYTES + 1)}\n`);

    expect(await ended).toBe("transport_failed");
    expect(io.lines).toEqual([]);
  });

  it("accepts a message just under the limit", async () => {
    const io = streams();
    const ended = serveMcp(application(), { ...io, signal: new AbortController().signal });
    const padding = "p".repeat(MCP_MAX_MESSAGE_BYTES - 1_000);

    io.send({ ...toolsListRequest(1), params: { _meta: MODERN_META, padding } });
    await io.whenLines(1);
    io.stdin.end();

    expect(await ended).toBe("closed");
    expect(JSON.parse(io.lines[0] ?? "")).toMatchObject({ id: 1 });
  });

  it("survives a malformed line and keeps serving", async () => {
    const io = streams();
    const ended = serveMcp(application(), { ...io, signal: new AbortController().signal });

    io.stdin.write("this is not json\n");
    io.send(toolsListRequest(7));
    await io.whenLines(1);
    io.stdin.end();

    expect(await ended).toBe("closed");
    expect(JSON.parse(io.lines[0] ?? "")).toMatchObject({ id: 7 });
  });

  it("closes the connection when asked to stop, even with stdin still open", async () => {
    const io = streams();
    const stop = new AbortController();
    const ended = serveMcp(application(), { ...io, signal: stop.signal });

    io.send(toolsListRequest(1));
    await io.whenLines(1);
    stop.abort();

    expect(await ended).toBe("closed");
  });

  it("closes at once when the stop was already requested", async () => {
    const io = streams();
    const stop = new AbortController();

    stop.abort();

    expect(await serveMcp(application(), { ...io, signal: stop.signal })).toBe("closed");
  });
});
