import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_SHUTDOWN_GRACE_MS } from "../../src/bootstrap/serve-mcp.js";
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_TERMINATED } from "../../src/entrypoints/exit-codes.js";
import {
  CLI_ENTRY,
  DIST_CLI_ENTRY,
  GATED_WRITE_ENTRY,
  type McpChild,
  withinLimit,
  withMcpChild,
} from "./mcp-child.js";
import { callToolRequest, modernRequest } from "./mcp-wire.js";

/** The longest a stopped server may take: the grace, the slack, and a loaded machine's headroom. */
const EXIT_LIMIT_MS = 15_000;

/** Less than the grace, allowing for timer granularity: a server that waited for nothing is not this. */
const WAITED_AT_LEAST_MS = MCP_SHUTDOWN_GRACE_MS - 300;

const KEY = "shutdown-write-key-0001";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function dataDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-shutdown-"));

  directories.push(dir);

  return dir;
}

async function noteCount(dir: string): Promise<number> {
  return (await readdir(join(dir, "notes")).catch(() => [])).filter((name) =>
    name.endsWith(".json"),
  ).length;
}

/** A server whose one write is held in its commit window and never released: a handler that never ends. */
function blockedWriteServer(compiled: boolean, dir: string) {
  return {
    entry: GATED_WRITE_ENTRY,
    compiled,
    args: [compiled ? "dist" : "src"],
    env: { DATA_DIR: dir },
  };
}

function production(compiled: boolean, dir: string) {
  return {
    entry: compiled ? DIST_CLI_ENTRY : CLI_ENTRY,
    compiled,
    args: ["mcp"],
    env: { DATA_DIR: dir },
  };
}

async function startBlockedWrite(child: McpChild): Promise<void> {
  await child.send(
    callToolRequest(1, "create_note", { text: "never finished", idempotencyKey: KEY }),
  );
  await child.whenIpc("write-entered", 0);
}

/** Time from `start` until the child exits, failing the test rather than hanging. */
async function exitAfter(child: McpChild, start: number) {
  const exit = await withinLimit(child.exited, "the server to exit");

  return { exit, elapsedMs: Date.now() - start };
}

/**
 * Bounded shutdown over real processes: the same scenarios for the TypeScript sources (through tsx)
 * and the built distribution (plain node), each through the real bin, so the forced exit at the
 * process boundary is what is tested. Nothing here waits on a sleep for correctness; times are
 * limits, and the child reports when it has reached a state.
 */
export function describeBoundedShutdown(label: string, compiled: boolean): void {
  describe(`bounded shutdown over real stdio (${label})`, () => {
    vi.setConfig({ testTimeout: 60_000 });

    it("ends within the bound, with exit 0, when stdin closes and a write never ends", async () => {
      const dir = await dataDirectory();

      await withMcpChild(blockedWriteServer(compiled, dir), async (child) => {
        await startBlockedWrite(child);

        const start = Date.now();

        child.endStdin();

        const { exit, elapsedMs } = await exitAfter(child, start);

        expect(exit).toEqual({ code: EXIT_OK, signal: null });
        // It waited for the handler for the grace, and then left without it.
        expect(elapsedMs).toBeGreaterThanOrEqual(WAITED_AT_LEAST_MS);
        expect(elapsedMs).toBeLessThan(EXIT_LIMIT_MS);
        // The gate was never released: nothing was committed, and nothing was answered or invented.
        expect(await noteCount(dir)).toBe(0);
        expect(child.stdoutLines).toEqual([]);
        expect(child.strayStdout()).toEqual([]);
        // It said that it gave up, with counts, and that the process was ended.
        expect(child.stderrText()).toContain("mcp.shutdown_incomplete");
        expect(child.stderrText()).toContain("mcp.shutdown_forced");
      });
    });

    it("exits promptly, without forcing anything, when nothing is in flight", async () => {
      await withMcpChild(production(compiled, await dataDirectory()), async (child) => {
        await child.send(modernRequest(1, "tools/list"));
        await child.whenResponse(1);

        const start = Date.now();

        child.endStdin();

        const { exit, elapsedMs } = await exitAfter(child, start);

        expect(exit).toEqual({ code: EXIT_OK, signal: null });
        expect(elapsedMs).toBeLessThan(MCP_SHUTDOWN_GRACE_MS);
        expect(child.stderrText()).not.toContain("mcp.shutdown");
      });
    });

    // Windows delivers no SIGINT or SIGTERM to a child; `kill()` there ends the process outright.
    describe.skipIf(process.platform === "win32")("stop signals (POSIX)", () => {
      it.each([
        ["SIGINT", EXIT_INTERRUPTED],
        ["SIGTERM", EXIT_TERMINATED],
      ] as const)(
        "%s ends the server within the bound, with the shell's code, when a write never ends",
        async (signal, code) => {
          const dir = await dataDirectory();

          await withMcpChild(blockedWriteServer(compiled, dir), async (child) => {
            await startBlockedWrite(child);

            const start = Date.now();

            child.kill(signal);

            const { exit, elapsedMs } = await exitAfter(child, start);

            // An exit code, not death by the signal: the server handled it and ended itself.
            expect(exit).toEqual({ code, signal: null });
            expect(elapsedMs).toBeGreaterThanOrEqual(WAITED_AT_LEAST_MS);
            expect(elapsedMs).toBeLessThan(EXIT_LIMIT_MS);
            expect(await noteCount(dir)).toBe(0);
            expect(child.stdoutLines).toEqual([]);
            expect(child.stderrText()).toContain("mcp.shutdown_forced");
          });
        },
      );

      it("keeps the first signal's code and the first deadline when more signals arrive", async () => {
        const dir = await dataDirectory();

        await withMcpChild(blockedWriteServer(compiled, dir), async (child) => {
          await startBlockedWrite(child);

          const start = Date.now();

          child.kill("SIGTERM");
          // Only once the first signal has been handled (the write was told to stop): signals that
          // are pending together are delivered in the operating system's order, not the sender's.
          await child.whenIpc("write-aborted", 0);
          child.kill("SIGINT");
          child.kill("SIGTERM");

          const { exit, elapsedMs } = await exitAfter(child, start);

          expect(exit).toEqual({ code: EXIT_TERMINATED, signal: null });
          expect(elapsedMs).toBeLessThan(EXIT_LIMIT_MS);
        });
      });

      it("lets a write that respects its signal finish, and exits before the grace is up", async () => {
        const dir = await dataDirectory();

        await withMcpChild(blockedWriteServer(compiled, dir), async (child) => {
          await startBlockedWrite(child);

          const start = Date.now();

          child.kill("SIGTERM");
          await child.whenIpc("write-aborted", 0);
          child.sendIpc({ type: "release", index: 0 });
          await child.whenIpc("write-committed", 0);

          const { exit, elapsedMs } = await exitAfter(child, start);

          expect(exit).toEqual({ code: EXIT_TERMINATED, signal: null });
          expect(elapsedMs).toBeLessThan(MCP_SHUTDOWN_GRACE_MS + 5_000);
          expect(child.stderrText()).not.toContain("mcp.shutdown_forced");
          expect(await noteCount(dir)).toBe(1);
        });
      });
    });
  });
}
