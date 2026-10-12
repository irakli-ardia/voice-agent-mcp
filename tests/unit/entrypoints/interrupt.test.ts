import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXIT_INTERRUPTED, EXIT_OK, EXIT_TERMINATED } from "../../../src/entrypoints/exit-codes.js";
import { COMMAND_SHUTDOWN_BOUND_MS, runUntilStopped } from "../../../src/entrypoints/interrupt.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const signals = new EventEmitter();
  const forced: number[] = [];
  const lines: string[] = [];

  return {
    signals,
    forced,
    lines,
    io: {
      signals,
      forceExit: (code: number): void => {
        forced.push(code);
      },
      stderr: (text: string): void => {
        lines.push(text);
      },
    },
  };
}

/** A command that stops when its signal aborts, as a cancelled turn does. */
const cooperative = async (signal: AbortSignal): Promise<number> =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(EXIT_INTERRUPTED), { once: true });
  });

const never = async (): Promise<number> => new Promise<number>(() => undefined);

describe("runUntilStopped", () => {
  it("aborts the command on the first SIGINT and resolves to the code of the command", async () => {
    const { signals, io } = setup();
    const result = runUntilStopped(cooperative, io);

    signals.emit("SIGINT");

    expect(await result).toBe(EXIT_INTERRUPTED);
  });

  it("reports 143 when the cancelling signal was SIGTERM", async () => {
    const { signals, io } = setup();
    const result = runUntilStopped(cooperative, io);

    signals.emit("SIGTERM");

    expect(await result).toBe(EXIT_TERMINATED);
  });

  it("keeps the own code of the command when it finished anyway", async () => {
    const { signals, io } = setup();
    const result = runUntilStopped(async () => EXIT_OK, io);

    signals.emit("SIGTERM");

    expect(await result).toBe(EXIT_OK);
  });

  it("removes its listeners when the command ends", async () => {
    const { signals, io } = setup();

    await runUntilStopped(async () => EXIT_OK, io);

    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("ends the process at once, with the first code, on a second signal", () => {
    const { signals, forced, io } = setup();

    void runUntilStopped(never, io);
    signals.emit("SIGTERM");
    expect(forced).toEqual([]);

    signals.emit("SIGINT");

    expect(forced).toEqual([EXIT_TERMINATED]);
  });

  it("ends the process after the bound when the command ignores the signal", () => {
    const { signals, forced, lines, io } = setup();

    void runUntilStopped(never, io);
    signals.emit("SIGINT");
    vi.advanceTimersByTime(COMMAND_SHUTDOWN_BOUND_MS - 1);
    expect(forced).toEqual([]);

    vi.advanceTimersByTime(1);

    expect(forced).toEqual([EXIT_INTERRUPTED]);
    expect(lines.join("")).toBe("error: the command did not finish in time and was ended\n");
  });

  it("ends the process after the bound when the command finished but something keeps it alive", async () => {
    const { forced, io } = setup();

    expect(await runUntilStopped(async () => 75, io)).toBe(75);
    vi.advanceTimersByTime(COMMAND_SHUTDOWN_BOUND_MS);

    expect(forced).toEqual([75]);
  });

  it("uses one timer, however many signs of the end arrive", async () => {
    const { signals, forced, io } = setup();
    const result = runUntilStopped(cooperative, io);

    signals.emit("SIGINT");
    await result;
    vi.advanceTimersByTime(COMMAND_SHUTDOWN_BOUND_MS * 3);

    expect(forced).toHaveLength(1);
  });
});
