import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_SHUTDOWN_BOUND_MS } from "../../../src/entrypoints/interrupt.js";

/**
 * Bounded shutdown of `ask`, in real processes running the built distribution: the same
 * `runUntilStopped` the bin wraps around `ask`, around commands the test controls. Signals can only
 * be delivered on POSIX; on Windows a console Ctrl+C is the only stop, so only the backstop that
 * ends a command that finished but is still held open is exercised there.
 */
const HARNESS = join(import.meta.dirname, "..", "..", "helpers", "ask-shutdown-child.mjs");

const SIGNALS_WORK = process.platform !== "win32";

/** Headroom over the bound for a loaded machine. */
const HEADROOM_MS = 5_000;

interface Run {
  readonly child: ChildProcess;
  readonly stderr: () => string;
  readonly ready: Promise<void>;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>;
}

function start(scenario: string): Run {
  const child = spawn(process.execPath, [HARNESS, scenario], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const ready = new Promise<void>((resolve) => {
    child.stdout?.once("data", () => resolve());
  });

  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null; at: number }>(
    (resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal, at: Date.now() }));
    },
  );

  return { child, stderr: () => stderr, ready, exit };
}

describe("ask shutdown, built distribution", () => {
  it("uses the documented bound", () => {
    expect(COMMAND_SHUTDOWN_BOUND_MS).toBe(2_500);
  });

  it("ends a command that finished but is held open, keeping its exit code, within the bound", async () => {
    const run = start("held");
    const startedAt = Date.now();

    const ended = await run.exit;

    expect(ended.code).toBe(0);
    expect(ended.at - startedAt).toBeGreaterThanOrEqual(COMMAND_SHUTDOWN_BOUND_MS - 300);
    expect(ended.at - startedAt).toBeLessThan(COMMAND_SHUTDOWN_BOUND_MS + HEADROOM_MS);
    expect(run.stderr()).toContain("did not finish in time");
  });

  it.runIf(SIGNALS_WORK)("stops a cooperative command on SIGINT with 130, at once", async () => {
    const run = start("cooperative");

    await run.ready;

    const sentAt = Date.now();

    run.child.kill("SIGINT");

    const ended = await run.exit;

    expect(ended.code).toBe(130);
    expect(ended.at - sentAt).toBeLessThan(COMMAND_SHUTDOWN_BOUND_MS);
    expect(run.stderr()).toBe("");
  });

  it.runIf(SIGNALS_WORK)("stops a cooperative command on SIGTERM with 143", async () => {
    const run = start("cooperative");

    await run.ready;
    run.child.kill("SIGTERM");

    expect((await run.exit).code).toBe(143);
  });

  it.runIf(SIGNALS_WORK)(
    "ends a command that ignores SIGTERM after the bound, with 143",
    async () => {
      const run = start("stuck");

      await run.ready;

      const sentAt = Date.now();

      run.child.kill("SIGTERM");

      const ended = await run.exit;

      expect(ended.code).toBe(143);
      expect(ended.at - sentAt).toBeGreaterThanOrEqual(COMMAND_SHUTDOWN_BOUND_MS - 300);
      expect(ended.at - sentAt).toBeLessThan(COMMAND_SHUTDOWN_BOUND_MS + HEADROOM_MS);
      expect(run.stderr()).toContain("did not finish in time");
    },
  );

  it.runIf(SIGNALS_WORK)("ends a stuck command at once on a second signal, with 130", async () => {
    const run = start("stuck");

    await run.ready;

    const sentAt = Date.now();

    run.child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 100));
    run.child.kill("SIGINT");

    const ended = await run.exit;

    expect(ended.code).toBe(130);
    expect(ended.at - sentAt).toBeLessThan(COMMAND_SHUTDOWN_BOUND_MS - 500);
  });
});
