import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type Application, createApplication } from "../../../src/bootstrap/create-application.js";
import type { Config } from "../../../src/config/config.js";
import {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_SOFTWARE,
  EXIT_TERMINATED,
  EXIT_USAGE,
} from "../../../src/entrypoints/exit-codes.js";
import { runMcpStdio } from "../../../src/entrypoints/mcp-stdio.js";
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

function start(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
  create?: (config: Config) => Application,
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
    { stdin, stdout, signals, stderr: (text) => stderr.push(text), env },
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
