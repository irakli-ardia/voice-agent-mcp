import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MCP_SHUTDOWN_GRACE_MS } from "../../../src/bootstrap/serve-mcp.js";
import { EXIT_INTERRUPTED, EXIT_TERMINATED } from "../../../src/entrypoints/exit-codes.js";
import { MCP_FORCE_EXIT_SLACK_MS, runMcpStdio } from "../../../src/entrypoints/mcp-stdio.js";

// A server whose connection never ends, whatever is asked of it: the shutdown that lives inside
// `serveMcp` cannot help, so only the entrypoint's own backstop can end the process.
const hungServe = async (): Promise<never> => new Promise<never>(() => {});

describe("runMcpStdio: a server that never returns", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function start(forceExit: (code: number) => void) {
    const signals = new EventEmitter();

    void runMcpStdio(
      [],
      {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        signals,
        stderr: () => {},
        env: { LOG_LEVEL: "silent", DATA_DIR: join(tmpdir(), "mcp-stdio-hung-never-written") },
        forceExit,
      },
      undefined,
      hungServe,
    );

    return signals;
  }

  it.each([
    ["SIGTERM", EXIT_TERMINATED],
    ["SIGINT", EXIT_INTERRUPTED],
  ])(
    "is ended after the grace and the slack from %s, with that signal's code",
    async (signal, code) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const forced: number[] = [];
      const signals = start((exitCode) => forced.push(exitCode));

      signals.emit(signal);
      await vi.advanceTimersByTimeAsync(MCP_SHUTDOWN_GRACE_MS + MCP_FORCE_EXIT_SLACK_MS - 1);

      expect(forced).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);

      expect(forced).toEqual([code]);
    },
  );

  it("is not ended while it runs and no signal came", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const forced: number[] = [];

    start((exitCode) => forced.push(exitCode));
    await vi.advanceTimersByTimeAsync(600_000);

    expect(forced).toEqual([]);
  });
});
