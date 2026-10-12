import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { mapToolResult } from "../../../src/adapters/mcp/mcp-result-mapper.js";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import {
  OUTPUT_QUEUE_BASE_BYTES,
  outputQueueLimit,
  serveMcp,
} from "../../../src/bootstrap/serve-mcp.js";
import { ok } from "../../../src/domain/result.js";
import { createRecordingLogger } from "../../helpers/recording-logger.js";
import { testConfig } from "../../helpers/test-config.js";

vi.setConfig({ testTimeout: 30_000 });

const MIB = 1_048_576;

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

async function turn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** The limit for a configuration with these two settings and the defaults for the rest. */
function limitFor(maxToolResultBytes: number, maxInFlightCalls: number): number {
  const config = testConfig({
    dataDir: "serve-mcp-output-limit-never-written",
    maxToolResultBytes,
    mcp: { maxInFlightCalls, maxCallsPerSecond: 20 },
  });

  return outputQueueLimit(config);
}

describe("outputQueueLimit", () => {
  it("reads the result cap and the in-flight cap from the configuration, each only where it belongs", () => {
    expect(limitFor(1_000, 10)).toBe(OUTPUT_QUEUE_BASE_BYTES + 10 * (3 * 1_000 + 4_096));
    expect(limitFor(10, 1_000)).toBe(OUTPUT_QUEUE_BASE_BYTES + 1_000 * (3 * 10 + 4_096));
  });

  it("is 32 MiB plus a full-size answer for every call that can be running", () => {
    expect(OUTPUT_QUEUE_BASE_BYTES).toBe(32 * MIB);
    expect(limitFor(16_384, 16)).toBe(32 * MIB + 16 * (3 * 16_384 + 4_096));
  });

  it("is about 33 MiB with the defaults", () => {
    const limit = limitFor(16_384, 16);

    expect(limit).toBe(34_406_400);
    expect(limit / MIB).toBeCloseTo(32.8, 1);
  });

  it("grows with what the configuration allows, and no further", () => {
    const largest = limitFor(MIB, 128);

    expect(largest).toBe(436_731_904);
    expect(largest).toBeGreaterThan(128 * 3 * MIB);
    expect(limitFor(MIB, 1)).toBeLessThan(limitFor(MIB, 2));
    expect(limitFor(1, 1)).toBeGreaterThan(OUTPUT_QUEUE_BASE_BYTES);
  });

  it("is above the largest answer of every call a client can have running at the largest settings", () => {
    // A fixed 64 MiB would not be: 128 calls of 3 MiB each is 384 MiB of legitimate answers.
    expect(limitFor(MIB, 128)).toBeGreaterThan(64 * MIB);
    expect(limitFor(16_384, 16)).toBeLessThan(64 * MIB);
  });

  it.each([
    ["quotes", '"'],
    ["backslashes", "\\"],
  ])(
    "is not below the largest possible answer: one result of %s at the cap",
    (_label, character) => {
      for (const cap of [16_384, MIB]) {
        // The worst case for the text copy: every character is escaped once in the result's JSON
        // and again in the text that carries it.
        const characters = Math.floor((cap - 8) / 2);
        const value = { s: character.repeat(characters) };

        expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(cap);

        const answer = JSON.stringify({
          result: { ...mapToolResult(ok(value)), resultType: "complete" },
          jsonrpc: "2.0",
          id: 1_000_000,
        });

        const bytes = new TextEncoder().encode(answer).byteLength;

        expect(bytes).toBeLessThanOrEqual(3 * cap + 4_096);
        expect(bytes).toBeGreaterThan(2.9 * cap);
      }
    },
  );
});

describe("serveMcp: an output queue that passes its limit", () => {
  function setup(limit: number) {
    const logger = createRecordingLogger();

    const application = {
      ...createApplication(testConfig({ dataDir: "serve-mcp-output-limit-never-written" })),
      logger,
    };

    const stdin = new PassThrough();
    const held: (() => void)[] = [];
    const written: Buffer[] = [];

    // A reader that is not reading: nothing it is given is ever completed.
    const stdout = new Writable({
      highWaterMark: 1,
      write: (chunk: Buffer, _encoding, callback): void => {
        written.push(chunk);
        held.push(callback);
      },
    });

    const stop = new AbortController();

    const ended = serveMcp(application, {
      stdin,
      stdout,
      signal: stop.signal,
      maxOutputQueueBytes: limit,
    });

    return { logger, stdin, stdout, written, ended, stop };
  }

  it("fails the connection instead of dropping an answer, and says so in a static event", async () => {
    // One `tools/list` answer is about 5 KB: the fifth passes 20 000 bytes.
    const { logger, stdin, ended } = setup(20_000);

    for (let id = 1; id <= 10; id += 1) {
      stdin.write(toolsList(id));
      await turn();
    }

    expect(await ended).toBe("transport_failed");
    expect(logger.entries.map((entry) => entry.message)).toContain("mcp.output_queue_overflow");
    expect(logger.entries.find((entry) => entry.message === "mcp.output_queue_overflow")).toEqual({
      level: "error",
      message: "mcp.output_queue_overflow",
      fields: { limitBytes: 20_000 },
    });
    expect(logger.entries.map((entry) => entry.message)).toContain("mcp.transport_error");
  });

  it("never logs what it was holding", async () => {
    const { logger, stdin, ended } = setup(20_000);

    for (let id = 1; id <= 10; id += 1) {
      stdin.write(toolsList(id));
      await turn();
    }

    await ended;

    const text = JSON.stringify(logger.entries);

    expect(text).not.toContain("get_current_time");
    expect(text).not.toContain("inputSchema");
  });

  it("does not fail while the queue stays within the limit", async () => {
    const { logger, stdin, stop, ended } = setup(10 * MIB);

    for (let id = 1; id <= 20; id += 1) {
      stdin.write(toolsList(id));
      await turn();
    }

    stop.abort();

    expect(await ended).toBe("closed");
    expect(logger.entries.map((entry) => entry.message)).not.toContain("mcp.output_queue_overflow");
  });

  it("writes whole answers, in order, up to the point of failure", async () => {
    const { stdin, written, ended } = setup(20_000);

    for (let id = 1; id <= 10; id += 1) {
      stdin.write(toolsList(id));
      await turn();
    }

    await ended;

    // The target holds one write at a time and none completes: only the first reached it, whole.
    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(written[0]?.toString() ?? "")).toMatchObject({ jsonrpc: "2.0", id: 1 });
  });
});
