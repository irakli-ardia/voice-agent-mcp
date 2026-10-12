import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import { serveMcp } from "../../../src/bootstrap/serve-mcp.js";
import { testConfig } from "../../helpers/test-config.js";

// Each test pushes hundreds of responses through real streams; a loaded machine needs headroom.
vi.setConfig({ testTimeout: 30_000 });

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

function toolsList(id: number): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    params: { _meta: MODERN_META },
  })}\n`;
}

const idOf = z.looseObject({ id: z.number() });

function application() {
  return createApplication(testConfig({ dataDir: "serve-mcp-backpressure-never-written" }));
}

async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** A stdout whose reader is not reading: writes are held until the test lets them through. */
function stalledStdout() {
  const held: { readonly chunk: Buffer; readonly callback: () => void }[] = [];
  const written: string[] = [];

  const stdout = new Writable({
    highWaterMark: 1,
    write: (chunk: Buffer, _encoding, callback): void => {
      held.push({ chunk, callback: () => callback() });
    },
  });

  const release = (count = held.length): void => {
    for (const item of held.splice(0, count)) {
      written.push(item.chunk.toString());
      item.callback();
    }
  };

  const lines = (): string[] => written.join("").split("\n").filter(Boolean);

  const ids = (): number[] => lines().map((line) => idOf.parse(JSON.parse(line)).id);

  return { stdout, release, held: () => held.length, lines, ids };
}

/** Lets a reader catch up completely, turn by turn, until `done`. */
async function drainUntil(
  stalled: ReturnType<typeof stalledStdout>,
  done: () => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 5_000 && !done(); attempt += 1) {
    stalled.release();
    await turn();
  }
}

describe("serveMcp: stdout backpressure", () => {
  it("stops reading requests while stdout is full, and answers every one once it is read", async () => {
    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();
    const ended = serveMcp(application(), { stdin, stdout: stalled.stdout, signal: stop.signal });
    const total = 300;

    for (let id = 1; id <= total; id += 1) {
      stdin.write(toolsList(id));
      await turn();
    }

    // Nobody has read anything: the server stopped taking requests long before the 600th.
    expect(stdin.isPaused()).toBe(true);
    expect(stdin.readableLength).toBeGreaterThan(0);
    expect(stalled.lines()).toEqual([]);
    expect(stalled.held()).toBeLessThanOrEqual(1);

    await drainUntil(stalled, () => stalled.ids().length >= total);

    expect([...stalled.ids()].sort((a, b) => a - b)).toEqual(
      Array.from({ length: total }, (_, index) => index + 1),
    );

    stdin.end();

    expect(await ended).toBe("closed");
  });

  it("keeps every answer a whole JSON-RPC line, in the order produced", async () => {
    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();
    const ended = serveMcp(application(), { stdin, stdout: stalled.stdout, signal: stop.signal });

    for (let id = 1; id <= 100; id += 1) {
      stdin.write(toolsList(id));
    }

    await drainUntil(stalled, () => stalled.ids().length >= 100);

    for (const line of stalled.lines()) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }

    expect(stalled.ids()).toEqual(Array.from({ length: 100 }, (_, index) => index + 1));

    stdin.end();
    await ended;
  });

  it("resumes reading once the output has drained", async () => {
    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();
    const ended = serveMcp(application(), { stdin, stdout: stalled.stdout, signal: stop.signal });

    for (let id = 1; id <= 300; id += 1) {
      stdin.write(toolsList(id));
    }

    await turn();

    expect(stdin.isPaused()).toBe(true);

    await drainUntil(stalled, () => stalled.ids().length >= 300);

    expect(stdin.isPaused()).toBe(false);

    stdin.write(toolsList(301));
    await drainUntil(stalled, () => stalled.ids().includes(301));

    expect(stalled.ids()).toContain(301);

    stdin.end();
    await ended;
  });

  it("sees the end of input only after stdout drains, then ends cleanly with every answer written", async () => {
    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();
    const ended = serveMcp(application(), { stdin, stdout: stalled.stdout, signal: stop.signal });
    let outcome: string | undefined;

    void ended.then((result) => {
      outcome = result;
    });

    let id = 0;

    // One request per turn until the server stops reading, then a few more and the end of input.
    while (!stdin.isPaused() && id < 1_000) {
      id += 1;
      stdin.write(toolsList(id));
      await turn();
    }

    expect(stdin.isPaused()).toBe(true);

    for (let extra = 0; extra < 20; extra += 1) {
      id += 1;
      stdin.write(toolsList(id));
    }

    stdin.end();

    for (let index = 0; index < 10; index += 1) {
      await turn();
    }

    expect(outcome).toBeUndefined();

    await drainUntil(stalled, () => outcome !== undefined);

    // The connection is over, but what was already answered is still written out in full.
    await drainUntil(stalled, () => stalled.held() === 0);

    expect(outcome).toBe("closed");
    // Requests still in flight when the end of input is processed get no answer (the M5 rule), so
    // not all 'id' of them are answered; what was answered is whole, unique, and from this session.
    expect(new Set(stalled.ids()).size).toBe(stalled.ids().length);
    expect(stalled.ids().every((answered) => answered >= 1 && answered <= id)).toBe(true);
    expect(stalled.ids().slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("closes on a stop request even while stdout is stalled and stdin is paused", async () => {
    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();
    const ended = serveMcp(application(), { stdin, stdout: stalled.stdout, signal: stop.signal });

    for (let id = 1; id <= 300; id += 1) {
      stdin.write(toolsList(id));
    }

    await turn();

    expect(stdin.isPaused()).toBe(true);

    stop.abort();

    expect(await ended).toBe("closed");
  });

  it("leaves stdin alone once the connection is over, even when stdout drains later", async () => {
    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();
    const ended = serveMcp(application(), { stdin, stdout: stalled.stdout, signal: stop.signal });

    for (let id = 1; id <= 300; id += 1) {
      stdin.write(toolsList(id));
    }

    await turn();

    expect(stdin.isPaused()).toBe(true);

    stop.abort();
    await ended;
    await drainUntil(stalled, () => stalled.held() === 0);

    // The server stopped reading for good: a late drain must not start the input flowing again.
    expect(stdin.isPaused()).toBe(true);
  });

  it("reports a transport failure when stdout breaks while it is stalled", async () => {
    const stalled = stalledStdout();
    const stdin = new PassThrough();
    const stop = new AbortController();
    const ended = serveMcp(application(), { stdin, stdout: stalled.stdout, signal: stop.signal });

    for (let id = 1; id <= 300; id += 1) {
      stdin.write(toolsList(id));
    }

    await turn();
    stalled.stdout.destroy(new Error("EPIPE"));

    expect(await ended).toBe("transport_failed");
  });

  it("reports a transport failure when a write to stdout fails", async () => {
    const stdin = new PassThrough();
    const stop = new AbortController();

    const stdout = new Writable({
      write: (_chunk, _encoding, callback): void => callback(new Error("write failed")),
    });

    const ended = serveMcp(application(), { stdin, stdout, signal: stop.signal });

    stdin.write(toolsList(1));

    expect(await ended).toBe("transport_failed");
  });

  it("does not slow or pause a reader that keeps up", async () => {
    const stdin = new PassThrough();
    const stop = new AbortController();
    const lines: string[] = [];

    const stdout = new Writable({
      write: (chunk: Buffer, _encoding, callback): void => {
        lines.push(...chunk.toString().split("\n").filter(Boolean));
        callback();
      },
    });

    const ended = serveMcp(application(), { stdin, stdout, signal: stop.signal });

    for (let id = 1; id <= 2_000; id += 1) {
      stdin.write(toolsList(id));

      if (id % 50 === 0) {
        await turn();
      }
    }

    for (let attempt = 0; attempt < 500 && lines.length < 2_000; attempt += 1) {
      await turn();
    }

    expect(lines).toHaveLength(2_000);
    expect(stdin.isPaused()).toBe(false);

    stdin.end();
    expect(await ended).toBe("closed");
  });
});
