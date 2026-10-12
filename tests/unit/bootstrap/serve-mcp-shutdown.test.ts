import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  type CallAdmission,
  createCallAdmission,
} from "../../../src/adapters/mcp/call-admission.js";
import type { Application } from "../../../src/bootstrap/create-application.js";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import { MCP_SHUTDOWN_GRACE_MS, serveMcp } from "../../../src/bootstrap/serve-mcp.js";
import { ok } from "../../../src/domain/result.js";
import { createFakeClock } from "../../helpers/fake-clock.js";
import { createRecordingLogger } from "../../helpers/recording-logger.js";
import { testConfig } from "../../helpers/test-config.js";

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const GRACE_MS = 60;

function toolsList(id: number): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: { _meta: MODERN_META } })}\n`;
}

function addCall(id: number): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "calculate", arguments: { operation: "add", a: 1, b: 2 }, _meta: MODERN_META },
  })}\n`;
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function until(done: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 2_000 && !done(); attempt += 1) {
    await turn();
  }
}

/** A handler the executor has started and that never settles, as one blocked in I/O would not. */
function blockedApplication(logger = createRecordingLogger()) {
  const base = createApplication(testConfig({ dataDir: "serve-mcp-shutdown-never-written" }));
  const state = { started: 0, aborted: 0, sawAbortAt: 0 };

  const application: Application = {
    ...base,
    logger,
    executeTool: async (_call, signal) => {
      const entry = base.handlerLedger.enter();

      state.started += 1;
      signal.addEventListener(
        "abort",
        () => {
          state.aborted += 1;
          state.sawAbortAt = Date.now();
        },
        { once: true },
      );

      // Never settles: it ignores its signal.
      await new Promise(() => {});
      entry?.settle();

      return ok({});
    },
  };

  return { application, state, logger };
}

/** A handler that stops when its signal aborts, as the note store does before its link. */
function cooperativeApplication(logger = createRecordingLogger()) {
  const base = createApplication(testConfig({ dataDir: "serve-mcp-shutdown-never-written" }));
  const state = { started: 0 };

  const application: Application = {
    ...base,
    logger,
    executeTool: async (_call, signal) => {
      const entry = base.handlerLedger.enter();

      state.started += 1;

      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      entry?.settle();

      return ok({});
    },
  };

  return { application, state, logger };
}

function stalledStdout() {
  const held: (() => void)[] = [];

  const stdout = new Writable({
    highWaterMark: 1,
    write: (_chunk: Buffer, _encoding, callback): void => {
      held.push(() => callback());
    },
  });

  return {
    stdout,
    held: () => held.length,
    release: (): void => {
      for (const callback of held.splice(0)) {
        callback();
      }
    },
  };
}

const incompleteFields = z.object({
  graceMs: z.number(),
  unsettledHandlers: z.number(),
  abandonedHandlers: z.number(),
  undeliveredBytes: z.number(),
  undeliveredChunks: z.number(),
});

function incompleteLogs(logger: ReturnType<typeof createRecordingLogger>) {
  return logger.entries.filter((entry) => entry.message === "mcp.shutdown_incomplete");
}

describe("serveMcp: bounded shutdown", () => {
  it("uses a two second grace by default", () => {
    expect(MCP_SHUTDOWN_GRACE_MS).toBe(2_000);
  });

  it("ends after the grace when a handler never settles, and says what it gave up", async () => {
    const { application, state, logger } = blockedApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      shutdownGraceMs: GRACE_MS,
    });

    stdin.write(addCall(1));
    await until(() => state.started === 1);

    const stoppedAt = Date.now();

    stop.abort();

    expect(await ended).toBe("closed");

    // Bounded: not before the grace, and not meaningfully after it.
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(GRACE_MS - 5);
    expect(Date.now() - stoppedAt).toBeLessThan(GRACE_MS + 1_000);
    // The handler was told, and could not be stopped.
    expect(state.aborted).toBe(1);
    expect(application.handlerLedger.counts().unsettled).toBe(1);

    const [entry] = incompleteLogs(logger);

    expect(entry?.level).toBe("warn");
    expect(incompleteFields.parse(entry?.fields)).toEqual({
      graceMs: GRACE_MS,
      unsettledHandlers: 1,
      abandonedHandlers: expect.any(Number),
      undeliveredBytes: 0,
      undeliveredChunks: 0,
    });
  });

  it("ends at once, with no warning, when the handler stops on its signal", async () => {
    const { application, state, logger } = cooperativeApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      shutdownGraceMs: 30_000,
    });

    stdin.write(addCall(1));
    await until(() => state.started === 1);

    const stoppedAt = Date.now();

    stop.abort();

    expect(await ended).toBe("closed");
    expect(Date.now() - stoppedAt).toBeLessThan(5_000);
    expect(application.handlerLedger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    expect(incompleteLogs(logger)).toEqual([]);
  });

  it("ends after the grace when stdout never drains, and reports the answers it did not deliver", async () => {
    const logger = createRecordingLogger();

    const application: Application = {
      ...createApplication(testConfig({ dataDir: "serve-mcp-shutdown-never-written" })),
      logger,
    };

    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout: stalled.stdout,
      signal: stop.signal,
      shutdownGraceMs: GRACE_MS,
    });

    for (let id = 1; id <= 300; id += 1) {
      stdin.write(toolsList(id));
    }

    await until(() => stdin.isPaused());
    expect(stdin.isPaused()).toBe(true);

    stop.abort();

    expect(await ended).toBe("closed");

    const [entry] = incompleteLogs(logger);
    const fields = incompleteFields.parse(entry?.fields);

    expect(fields.unsettledHandlers).toBe(0);
    expect(fields.undeliveredBytes).toBeGreaterThan(0);
    expect(fields.undeliveredChunks).toBeGreaterThan(0);
  });

  it("writes out what was queued, and ends at once, when stdout drains within the grace", async () => {
    const logger = createRecordingLogger();

    const application: Application = {
      ...createApplication(testConfig({ dataDir: "serve-mcp-shutdown-never-written" })),
      logger,
    };

    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout: stalled.stdout,
      signal: stop.signal,
      shutdownGraceMs: 30_000,
    });

    for (let id = 1; id <= 300; id += 1) {
      stdin.write(toolsList(id));
    }

    await until(() => stdin.isPaused());
    stop.abort();

    let outcome: string | undefined;

    void ended.then((result) => {
      outcome = result;
    });

    // Held, not given up: the server is waiting for the reader.
    await turn();
    await turn();
    expect(outcome).toBeUndefined();

    for (let attempt = 0; attempt < 5_000 && outcome === undefined; attempt += 1) {
      stalled.release();
      await turn();
    }

    expect(outcome).toBe("closed");
    expect(incompleteLogs(logger)).toEqual([]);
  });

  it("ends after the grace on a transport failure with a handler that never settles", async () => {
    const { application, state, logger } = blockedApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      shutdownGraceMs: GRACE_MS,
    });

    stdin.write(addCall(1));
    await until(() => state.started === 1);
    stdout.destroy(new Error("EPIPE"));
    stdin.write(addCall(2));

    // The failed write is what ends the connection: the next answer cannot be written.
    stdin.write(toolsList(3));

    expect(await ended).toBe("transport_failed");
    expect(incompleteLogs(logger)).toHaveLength(1);
  });

  it("starts the deadline once, however many signs of the end arrive", async () => {
    const { application, state, logger } = blockedApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      shutdownGraceMs: GRACE_MS,
    });

    stdin.write(addCall(1));
    await until(() => state.started === 1);

    stop.abort();
    stop.abort();
    stdin.end();

    expect(await ended).toBe("closed");
    expect(incompleteLogs(logger)).toHaveLength(1);
  });

  it("refuses to start a handler once the end has begun", async () => {
    const { application, state } = cooperativeApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      shutdownGraceMs: GRACE_MS,
    });

    stop.abort();
    expect(await ended).toBe("closed");

    // Nothing reads this: the connection is closed, so no call can reach the executor.
    stdin.write(addCall(1));
    await turn();

    expect(state.started).toBe(0);
  });
});

/** A real admission policy that counts how often it was closed, and whether a call was refused after. */
function watchedAdmission() {
  const real = createCallAdmission({
    clock: createFakeClock(),
    logger: createRecordingLogger(),
    maxCallsPerSecond: 20,
    maxInFlightCalls: 16,
  });

  const closes = { count: 0 };

  const admission: CallAdmission = {
    admit: () => real.admit(),
    close: () => {
      closes.count += 1;
      real.close();
    },
  };

  return { admission, closes, real };
}

describe("serveMcp: admission closes with the first sign of the end", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const { application } = cooperativeApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stop = new AbortController();
    const watched = watchedAdmission();

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      shutdownGraceMs: GRACE_MS,
      admission: watched.admission,
    });

    return { stdin, stdout, stop, ended, ...watched };
  }

  it("on a stop request", async () => {
    const run = setup();

    expect(run.closes.count).toBe(0);
    expect(run.real.admit().ok).toBe(true);

    run.stop.abort();
    await run.ended;

    expect(run.closes.count).toBeGreaterThanOrEqual(1);
    expect(run.real.admit()).toEqual({ ok: false, reason: "shutting_down" });
  });

  it("on the end of input", async () => {
    const run = setup();

    run.stdin.end();
    await run.ended;

    expect(run.real.admit()).toEqual({ ok: false, reason: "shutting_down" });
  });

  it("on a transport failure", async () => {
    const run = setup();

    run.stdout.destroy(new Error("EPIPE"));
    run.stdin.write(toolsList(1));

    expect(await run.ended).toBe("transport_failed");
    expect(run.real.admit()).toEqual({ ok: false, reason: "shutting_down" });
  });

  it("before the stop request is acted on, so a call read meanwhile is already refused", async () => {
    const run = setup();
    let closedBeforeEnd = false;

    void run.ended.then(() => {
      closedBeforeEnd = run.real.admit().ok === false;
    });
    run.stop.abort();
    await run.ended;

    expect(closedBeforeEnd).toBe(true);
  });

  it("measures the deadline from the first sign, not from a later one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const { application, state } = blockedApplication();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stop = new AbortController();
    let outcome: string | undefined;

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      shutdownGraceMs: 1_000,
    });

    void ended.then((result) => {
      outcome = result;
    });

    stdin.write(addCall(1));
    await until(() => state.started === 1);

    // The first sign: the connection fails. A later one, half a grace on, must not restart the clock.
    stdout.destroy(new Error("EPIPE"));
    stdin.write(toolsList(2));
    await until(() => application.handlerLedger.counts().unsettled === 1);
    await vi.advanceTimersByTimeAsync(500);
    stop.abort();
    await vi.advanceTimersByTimeAsync(499);

    expect(outcome).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);

    expect(await ended).toBe("transport_failed");
  });
});
