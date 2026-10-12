import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_SHUTDOWN_GRACE_MS } from "../../../src/bootstrap/serve-mcp.js";
import { MCP_FORCE_EXIT_SLACK_MS, MCP_LOG_FLUSH_MS } from "../../../src/entrypoints/mcp-stdio.js";
import { DIST_CLI_ENTRY } from "../../helpers/mcp-child.js";
import { callToolRequest } from "../../helpers/mcp-wire.js";

/**
 * The failure the M6 audit found (F2): a host that never reads the server's stderr. With
 * synchronous logging the built server answered about 310 calls at `LOG_LEVEL=info` and then
 * stopped for good. Here the real built server runs with a stderr pipe that nobody reads, for ten
 * times as many calls, and is then asked to stop.
 */
const CALLS = 3_000;

const BATCH = 100;

const MAX_RESIDENT_BYTES = 512 * 1024 * 1024;

/** The documented bound on an end: grace, slack, the log flush, and a loaded machine's headroom. */
const EXIT_LIMIT_MS = MCP_SHUTDOWN_GRACE_MS + MCP_FORCE_EXIT_SLACK_MS + MCP_LOG_FLUSH_MS + 5_000;

let data: string;

beforeEach(async () => {
  data = await mkdtemp(join(tmpdir(), "mcp-dist-stderr-"));
});

afterEach(async () => {
  await rm(data, { recursive: true, force: true });
});

/** Resident memory of a process we started, in bytes; `undefined` where this cannot be read. */
function residentBytes(pid: number): number | undefined {
  if (process.platform === "linux") {
    const kilobytes = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1];

    return kilobytes === undefined ? undefined : Number(kilobytes) * 1024;
  }

  if (process.platform === "win32") {
    const listing = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
    }).stdout;

    const kilobytes = /"([\d,.]+) K"\s*$/m.exec(listing)?.[1];

    return kilobytes === undefined ? undefined : Number(kilobytes.replace(/[,.]/g, "")) * 1024;
  }

  return undefined;
}

interface Server {
  readonly child: ChildProcess;
  readonly lines: string[];
  readonly exit: Promise<number | null>;
}

/** The built server with its stderr left unread: no listener, never resumed. */
function startServer(): Server {
  const child = spawn(process.execPath, [DIST_CLI_ENTRY, "mcp"], {
    env: {
      ...getDefaultEnvironment(),
      DATA_DIR: data,
      LOG_LEVEL: "info",
      MCP_MAX_CALLS_PER_SECOND: "1000",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines: string[] = [];
  let pending = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;

    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      lines.push(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }
  });
  child.stdin?.on("error", () => undefined);

  const exit = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  return { child, lines, exit };
}

/** Sends `count` calls, then waits until every one so far has been answered. */
async function callBatch(server: Server, firstId: number, count: number): Promise<void> {
  for (let id = firstId; id < firstId + count; id += 1) {
    server.child.stdin?.write(
      `${JSON.stringify(callToolRequest(id, "calculate", { operation: "add", a: id, b: 1 }))}\n`,
    );
  }

  await expect
    .poll(() => server.lines.length, { timeout: 20_000, interval: 10 })
    .toBeGreaterThanOrEqual(firstId + count - 1);
}

describe("the built server with a stderr nobody reads", () => {
  it("keeps answering, keeps stdout protocol-pure, keeps its memory bounded, and stops in time", async () => {
    const server = startServer();
    const { pid } = server.child;

    try {
      for (let sent = 0; sent < CALLS; sent += BATCH) {
        await callBatch(server, sent + 1, BATCH);
      }

      // Every call was answered, and everything on stdout is a JSON-RPC response.
      expect(server.lines).toHaveLength(CALLS);
      expect(server.lines.map((text) => JSON.parse(text))).toEqual(
        server.lines.map(() => expect.objectContaining({ jsonrpc: "2.0" })),
      );

      // A coarse sanity bound only. The log queue (at most 128 KiB, proven by the unit tests) is far
      // below the noise of a Node process's heap: measured, `info` and `silent` end within a few
      // megabytes of each other on both platforms.
      const rssAtEnd = pid === undefined ? undefined : residentBytes(pid);

      if (rssAtEnd !== undefined) {
        expect(rssAtEnd).toBeLessThan(MAX_RESIDENT_BYTES);
      }

      // Stopping with stderr still stalled is bounded.
      const closedAt = Date.now();

      server.child.stdin?.end();

      const code = await Promise.race([
        server.exit,
        new Promise<"late">((resolve) => setTimeout(() => resolve("late"), EXIT_LIMIT_MS)),
      ]);

      expect(code).toBe(0);
      expect(Date.now() - closedAt).toBeLessThan(EXIT_LIMIT_MS);
    } finally {
      // Only the process this test started, by the handle it was given.
      if (server.child.exitCode === null) {
        server.child.kill();
      }
    }
  });
});
