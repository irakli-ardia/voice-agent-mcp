import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Application, createApplication } from "../../../src/bootstrap/create-application.js";
import { MCP_SHUTDOWN_GRACE_MS } from "../../../src/bootstrap/serve-mcp.js";
import type { Config } from "../../../src/config/config.js";
import { ok } from "../../../src/domain/result.js";
import {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_SOFTWARE,
  EXIT_TERMINATED,
  EXIT_USAGE,
} from "../../../src/entrypoints/exit-codes.js";
import { MCP_FORCE_EXIT_SLACK_MS, runMcpStdio } from "../../../src/entrypoints/mcp-stdio.js";
import { createRecordingLogger } from "../../helpers/recording-logger.js";

const SECRET = "SENTINEL-SECRET-VALUE-4c1e";

interface Run {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly signals: EventEmitter;
  readonly stderr: string[];
  readonly stdoutText: () => string;
  readonly done: Promise<number>;
}

/** An absolute `DATA_DIR` that is never written: the application makes no file until a note is saved. */
const DATA_DIR = join(tmpdir(), "mcp-stdio-unit-never-written");

/** The server refuses to start without an explicit `DATA_DIR`; a test that is not about that has one. */
function withDataDir(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return "DATA_DIR" in env ? env : { DATA_DIR, ...env };
}

function start(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  create?: (config: Config) => Application,
  forceExit?: (code: number) => void,
): Run {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const signals = new EventEmitter();
  const stderr: string[] = [];
  let written = "";

  stdout.setEncoding("utf8");
  stdout.on("data", (chunk: string) => {
    written += chunk;
  });

  const done = runMcpStdio(
    argv,
    forceExit === undefined
      ? { stdin, stdout, signals, stderr: (text) => stderr.push(text), env: withDataDir(env) }
      : {
          stdin,
          stdout,
          signals,
          stderr: (text) => stderr.push(text),
          env: withDataDir(env),
          forceExit,
        },
    create ?? ((config) => createApplication({ ...config, logLevel: "silent" })),
  );

  return { stdin, stdout, signals, stderr, stdoutText: () => written, done };
}

function signalListeners(signals: EventEmitter): number {
  return signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM");
}

describe("runMcpStdio", () => {
  describe("arguments and configuration", () => {
    it.each([["--help"], ["extra"], ["--text", "hi"]])(
      "refuses %j: a usage error on stderr, nothing on stdout, no listener added",
      async (...argv) => {
        const run = start(argv);

        expect(await run.done).toBe(EXIT_USAGE);
        expect(run.stderr.join("")).toMatch(
          /^error: usage: mcp takes no arguments\n\nUsage: voice-agent/,
        );
        expect(run.stdoutText()).toBe("");
        expect(signalListeners(run.signals)).toBe(0);
      },
    );

    it("rejects invalid configuration with exit 78, naming the variable but not its value", async () => {
      const run = start([], { LOG_LEVEL: SECRET, MCP_MAX_IN_FLIGHT_CALLS: `${SECRET}-2` });

      expect(await run.done).toBe(EXIT_CONFIG);

      const text = run.stderr.join("");

      expect(text).toMatch(/^Invalid configuration:\n/);
      expect(text).toContain("LOG_LEVEL");
      expect(text).toContain("MCP_MAX_IN_FLIGHT_CALLS");
      expect(text).not.toContain(SECRET);
      expect(run.stdoutText()).toBe("");
      expect(signalListeners(run.signals)).toBe(0);
    });

    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["blank", "  "],
      ["relative", "notes"],
      ["a dot path", ".data"],
      ["a parent path", "../notes"],
      ["a home shorthand", "~/notes"],
    ])(
      "refuses to start when DATA_DIR is %s: exit 78, nothing built, nothing on stdout",
      async (_name, value) => {
        let built = 0;

        const run = start([], { DATA_DIR: value }, (config) => {
          built += 1;

          return createApplication({ ...config, logLevel: "silent" });
        });

        expect(await run.done).toBe(EXIT_CONFIG);
        expect(built).toBe(0);
        expect(run.stderr.join("")).toMatch(/^Invalid configuration:\n {2}DATA_DIR: /);
        expect(run.stdoutText()).toBe("");
        expect(signalListeners(run.signals)).toBe(0);
      },
    );

    it("never repeats a rejected DATA_DIR in what it prints", async () => {
      const run = start([], { DATA_DIR: `relative-${SECRET}` });

      expect(await run.done).toBe(EXIT_CONFIG);
      expect(run.stderr.join("")).not.toContain(SECRET);
    });

    it("reports a bad DATA_DIR together with other bad settings", async () => {
      const run = start([], { DATA_DIR: "relative", LOG_LEVEL: "loud" });

      expect(await run.done).toBe(EXIT_CONFIG);
      expect(run.stderr.join("")).toContain("DATA_DIR:");
      expect(run.stderr.join("")).toContain("LOG_LEVEL:");
    });

    it("starts with an absolute DATA_DIR, and builds the application from it", async () => {
      let received: string | undefined;

      const run = start([], { DATA_DIR }, (config) => {
        received = config.dataDir;

        return createApplication({ ...config, logLevel: "silent" });
      });

      run.stdin.end();

      expect(await run.done).toBe(EXIT_OK);
      expect(received).toBe(DATA_DIR);
    });

    it("needs no OpenAI key", async () => {
      const run = start([], { OPENAI_API_KEY: undefined });

      run.stdin.end();

      expect(await run.done).toBe(EXIT_OK);
      expect(run.stderr).toEqual([]);
    });
  });

  describe("ending", () => {
    it("exits 0 when the client closes stdin", async () => {
      const run = start([]);

      run.stdin.end();

      expect(await run.done).toBe(EXIT_OK);
      expect(run.stdin.destroyed).toBe(true);
      expect(run.stdoutText()).toBe("");
      expect(signalListeners(run.signals)).toBe(0);
    });

    it.each([
      ["SIGINT", EXIT_INTERRUPTED],
      ["SIGTERM", EXIT_TERMINATED],
    ])("closes on %s and exits with the shell's code for it", async (signal, code) => {
      const run = start([]);

      expect(signalListeners(run.signals)).toBe(2);
      run.signals.emit(signal);

      expect(await run.done).toBe(code);
      expect(run.stdin.destroyed).toBe(true);
      expect(signalListeners(run.signals)).toBe(0);
    });

    it("keeps the first signal's code when a second arrives", async () => {
      const run = start([]);

      run.signals.emit("SIGTERM");
      run.signals.emit("SIGINT");

      expect(await run.done).toBe(EXIT_TERMINATED);
    });

    it("exits 1 after an oversized message, logs a safe event, and writes nothing to stdout", async () => {
      const logger = createRecordingLogger();

      const run = start([], {}, (config) => ({
        ...createApplication({ ...config, logLevel: "silent" }),
        logger,
      }));

      run.stdin.write(`${SECRET.repeat(100_000)}\n`);

      expect(await run.done).toBe(EXIT_FAILURE);
      expect(run.stdin.destroyed).toBe(true);
      expect(run.stdoutText()).toBe("");
      expect(run.stderr).toEqual([]);
      expect(logger.entries.map((entry) => entry.message)).toEqual([
        "mcp.transport_error",
        "mcp.stopped",
      ]);
      expect(JSON.stringify(logger.entries)).not.toContain(SECRET);
      expect(JSON.stringify(logger.entries)).not.toContain("ReadBuffer");
      expect(signalListeners(run.signals)).toBe(0);
    });

    it("reports an unexpected failure by class only, exits 70, and removes its listeners", async () => {
      const run = start([], {}, () => {
        throw new Error(`startup failed ${SECRET}`);
      });

      expect(await run.done).toBe(EXIT_SOFTWARE);
      expect(run.stderr.join("")).toBe("error: mcp: unexpected failure (Error)\n");
      expect(run.stderr.join("")).not.toContain(SECRET);
      expect(run.stdoutText()).toBe("");
      expect(signalListeners(run.signals)).toBe(0);
    });

    it("reports a thrown non-error without its value", async () => {
      const run = start([], {}, () => {
        throw SECRET;
      });

      expect(await run.done).toBe(EXIT_SOFTWARE);
      expect(run.stderr.join("")).toBe("error: mcp: unexpected failure (non-error)\n");
    });
  });
});

const ADD_CALL = `${JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "calculate",
    arguments: { operation: "add", a: 1, b: 2 },
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
})}\n`;

describe("runMcpStdio: forced exit", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** An application whose one tool call never settles, as a call blocked in I/O would not. */
  function blockedCreate(started: { count: number }, logger = createRecordingLogger()) {
    return (config: Config): Application => {
      const base = createApplication({ ...config, logLevel: "silent" });

      return {
        ...base,
        logger,
        executeTool: async () => {
          base.handlerLedger.enter();
          started.count += 1;
          await new Promise(() => {});

          return ok({});
        },
      };
    };
  }

  async function untilStarted(started: { count: number }): Promise<void> {
    for (let attempt = 0; attempt < 2_000 && started.count === 0; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  it("ends the process with the signal's code, once, after the grace and the slack", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const started = { count: 0 };
    const logger = createRecordingLogger();
    const forced: number[] = [];
    const run = start([], {}, blockedCreate(started, logger), (code) => forced.push(code));

    run.stdin.write(ADD_CALL);
    await untilStarted(started);
    run.signals.emit("SIGTERM");

    await vi.advanceTimersByTimeAsync(MCP_SHUTDOWN_GRACE_MS - 1);

    expect(forced).toEqual([]);

    // The server gives up waiting for the handler at the grace, and returns the exit code...
    await vi.advanceTimersByTimeAsync(1);

    expect(await run.done).toBe(EXIT_TERMINATED);
    expect(forced).toEqual([]);

    // ...and the process, still alive because of the handler, is ended after the slack.
    await vi.advanceTimersByTimeAsync(MCP_FORCE_EXIT_SLACK_MS - 1);

    expect(forced).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(forced).toEqual([EXIT_TERMINATED]);
    expect(logger.entries.at(-1)).toEqual({
      level: "error",
      message: "mcp.shutdown_forced",
      fields: { exitCode: EXIT_TERMINATED },
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(forced).toEqual([EXIT_TERMINATED]);
  });

  it("uses SIGINT's code, and ignores a second signal: shutdown runs once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const started = { count: 0 };
    const forced: number[] = [];
    const run = start([], {}, blockedCreate(started), (code) => forced.push(code));

    run.stdin.write(ADD_CALL);
    await untilStarted(started);
    run.signals.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(1_000);
    run.signals.emit("SIGTERM");
    run.signals.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(MCP_SHUTDOWN_GRACE_MS + MCP_FORCE_EXIT_SLACK_MS);

    expect(await run.done).toBe(EXIT_INTERRUPTED);
    // The second signal did not restart the clock: the process was ended at the first one's deadline.
    expect(forced).toEqual([EXIT_INTERRUPTED]);
  });

  it("is still listening for signals during the shutdown, so a repeat is never the default kill", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const started = { count: 0 };
    const run = start([], {}, blockedCreate(started), () => {});

    run.stdin.write(ADD_CALL);
    await untilStarted(started);
    run.signals.emit("SIGTERM");

    expect(signalListeners(run.signals)).toBe(2);

    await vi.advanceTimersByTimeAsync(MCP_SHUTDOWN_GRACE_MS);
    await run.done;

    expect(signalListeners(run.signals)).toBe(0);
  });

  it("backstops a normal end too: a process still alive after the slack is ended with exit 0", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const forced: number[] = [];
    const run = start([], {}, undefined, (code) => forced.push(code));

    run.stdin.end();

    expect(await run.done).toBe(EXIT_OK);
    expect(forced).toEqual([]);

    await vi.advanceTimersByTimeAsync(MCP_FORCE_EXIT_SLACK_MS);

    expect(forced).toEqual([EXIT_OK]);
  });

  it("ends a failed connection with exit 1", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const forced: number[] = [];
    const run = start([], {}, undefined, (code) => forced.push(code));

    run.stdin.write(`${SECRET.repeat(100_000)}\n`);

    expect(await run.done).toBe(EXIT_FAILURE);

    await vi.advanceTimersByTimeAsync(MCP_FORCE_EXIT_SLACK_MS);

    expect(forced).toEqual([EXIT_FAILURE]);
  });

  it("ends a failed start with exit 70", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const forced: number[] = [];

    const run = start(
      [],
      {},
      () => {
        throw new Error("startup failed");
      },
      (code) => forced.push(code),
    );

    expect(await run.done).toBe(EXIT_SOFTWARE);

    await vi.advanceTimersByTimeAsync(MCP_FORCE_EXIT_SLACK_MS);

    expect(forced).toEqual([EXIT_SOFTWARE]);
  });

  it.each([
    ["a usage error", ["extra"], {}],
    ["invalid configuration", [], { LOG_LEVEL: "not-a-level" }],
  ])("never arms the exit for %s: nothing was started", async (_name, argv, env) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const forced: number[] = [];
    const run = start(argv, env, undefined, (code) => forced.push(code));

    await run.done;
    await vi.advanceTimersByTimeAsync(60_000);

    expect(forced).toEqual([]);
  });

  it("does nothing of the kind when the bin gave it no way to end the process", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const started = { count: 0 };
    const run = start([], {}, blockedCreate(started));

    run.stdin.write(ADD_CALL);
    await untilStarted(started);
    run.signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(MCP_SHUTDOWN_GRACE_MS);

    expect(await run.done).toBe(EXIT_TERMINATED);
    expect(vi.getTimerCount()).toBe(0);
  });
});
