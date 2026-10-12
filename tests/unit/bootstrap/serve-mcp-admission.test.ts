import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import { serveMcp } from "../../../src/bootstrap/serve-mcp.js";
import { testConfig } from "../../helpers/test-config.js";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function addCall(id: number): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "calculate", arguments: { operation: "add", a: id, b: 1 }, _meta: MODERN_META },
  })}\n`;
}

/** Runs `count` calls through the real server over plain streams and returns each answer's text. */
async function answers(
  mcp: { readonly maxInFlightCalls: number; readonly maxCallsPerSecond: number },
  count: number,
): Promise<string[]> {
  const application = createApplication(
    testConfig({ dataDir: "serve-mcp-admission-never-written", mcp }),
  );

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stop = new AbortController();
  const lines: string[] = [];
  let pending = "";

  stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();

    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      lines.push(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });

  const ended = serveMcp(application, { stdin, stdout, signal: stop.signal });

  for (let id = 1; id <= count; id += 1) {
    stdin.write(addCall(id));

    // One call at a time: each finishes (and frees its slot) before the next arrives.
    for (let wait = 0; wait < 500 && lines.length < id; wait += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  stop.abort();
  await ended;

  return lines.map((line) => JSON.stringify(JSON.parse(line)));
}

describe("serveMcp admission", () => {
  it("applies the configured rate to the calls the server answers", async () => {
    const lines = await answers({ maxInFlightCalls: 16, maxCallsPerSecond: 2 }, 3);

    expect(lines[0]).toContain('"result":2');
    expect(lines[1]).toContain('"result":3');
    expect(lines[2]).toContain("rate_limited: Too many tool calls; retry after a short delay.");
  });

  it("does not refuse sequential calls under either configured limit", async () => {
    const lines = await answers({ maxInFlightCalls: 1, maxCallsPerSecond: 1_000 }, 3);

    // Sequential calls never overlap, so none is busy and none is rate limited.
    expect(
      lines.filter((line) => line.includes("server_busy") || line.includes("rate_limited")),
    ).toEqual([]);
    expect(lines).toHaveLength(3);
  });

  it("lets every call through when the rate allows it", async () => {
    const lines = await answers({ maxInFlightCalls: 16, maxCallsPerSecond: 1_000 }, 5);

    expect(lines.every((line) => line.includes('"result"'))).toBe(true);
  });
});
