import { describe, expect, it } from "vitest";
import { type UnreadServer, withUnreadServer } from "./mcp-backpressure.js";
import { withinLimit } from "./mcp-child.js";

/** The most memory growth, in MB, a stalled or slow reader may cause. Unbounded growth was ~90 MB per 10 000. */
const RSS_GROWTH_LIMIT_MB = 60;

const FLOOD_LIMIT = 20_000;

/** Lets the first request warm the server up (compilation, caches) before memory is measured. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

/** Memory growth in MB; 0 where the platform cannot measure it, so the check passes there. */
function growthSince(before: number | undefined, after: number | undefined): number {
  return before === undefined || after === undefined ? 0 : after - before;
}

/** Floods the server until it stops taking input; returns how many requests were sent by then. */
async function stall(server: UnreadServer): Promise<number> {
  const { stalled } = await server.floodUntilStalled(FLOOD_LIMIT);

  expect(stalled).toBe(true);

  return server.issued();
}

function distinct(ids: readonly number[]): boolean {
  return new Set(ids).size === ids.length;
}

async function waitForAnswers(
  answered: () => readonly unknown[],
  count: number,
  what: string,
): Promise<void> {
  await withinLimit(
    (async () => {
      while (answered().length < count) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })(),
    what,
  );
}

/**
 * The same real-process scenarios for the TypeScript sources (through tsx) and the built
 * distribution (plain node): a client that sends requests and then reads nothing, reads slowly,
 * closes its end, or is told to stop. They hold on Windows (the OS pipe blocks the server) and
 * on Linux (the server must stop reading); only the memory check needs `/proc`.
 */
export function describeStdoutBackpressure(label: string, compiled: boolean): void {
  describe(`stdout backpressure over real stdio (${label})`, () => {
    it("stops taking requests from a client that reads nothing, and holds its memory", async () => {
      await withUnreadServer(compiled, async (server) => {
        await server.send(1);
        await settle();

        const before = server.rssMb();
        const { stalled } = await server.floodUntilStalled(FLOOD_LIMIT);

        expect(stalled).toBe(true);
        expect(server.issued()).toBeLessThan(FLOOD_LIMIT);

        expect(growthSince(before, server.rssMb())).toBeLessThan(RSS_GROWTH_LIMIT_MB);
      });
    }, 60_000);

    it("answers every request, whole, once the client reads again", async () => {
      await withUnreadServer(compiled, async (server) => {
        const issued = await stall(server);

        server.startReading();
        await waitForAnswers(() => server.answeredIds(), issued, `${issued} answers`);

        expect(server.answeredIds()).toHaveLength(issued);
        expect(distinct(server.answeredIds())).toBe(true);
        expect(server.strayLines()).toEqual([]);

        // The server took input again after the drain: send more and get those answered too.
        await server.send(50);
        await waitForAnswers(() => server.answeredIds(), issued + 50, "answers after resuming");

        server.endStdin();

        expect((await withinLimit(server.exited, "exit")).code).toBe(0);
      });
    }, 60_000);

    it("serves a slow reader completely, with bounded memory", async () => {
      await withUnreadServer(compiled, async (server) => {
        await server.send(1);
        await settle();

        const before = server.rssMb();

        server.startReading(25);
        await server.send(2_500);
        await waitForAnswers(() => server.answeredIds(), 2_501, "all answers from a slow reader");

        expect(distinct(server.answeredIds())).toBe(true);
        expect(server.strayLines()).toEqual([]);

        expect(growthSince(before, server.rssMb())).toBeLessThan(RSS_GROWTH_LIMIT_MB * 2);

        server.endStdin();

        expect((await withinLimit(server.exited, "exit")).code).toBe(0);
      });
    }, 90_000);

    it("ends cleanly when the client closes its end while the server is stalled, once it reads", async () => {
      await withUnreadServer(compiled, async (server) => {
        const { stalled } = await server.floodUntilStalled(FLOOD_LIMIT);

        expect(stalled).toBe(true);
        server.endStdin();
        server.startReading();

        const exit = await withinLimit(server.exited, "exit after reading");

        expect(exit.code).toBe(0);
        expect(server.answeredIds().length).toBeGreaterThan(0);
        expect(distinct(server.answeredIds())).toBe(true);
        expect(server.strayLines()).toEqual([]);
      });
    }, 60_000);

    it.skipIf(process.platform === "win32")(
      "exits 143 on SIGTERM while stalled, once the client reads, with complete answers only",
      async () => {
        await withUnreadServer(compiled, async (server) => {
          const issued = await stall(server);

          server.kill("SIGTERM");
          server.startReading();

          const exit = await withinLimit(server.exited, "exit after SIGTERM and reading");

          expect(exit).toEqual({ code: 143, signal: null });

          const ids = server.answeredIds();

          // Whatever was queued when the signal came is written out whole and in order, once: the
          // requests were numbered from 1, so what arrived is exactly 1..n.
          // How much was queued when the signal came depends on the kernel's socket buffer, so only
          // "something, whole and in order" can be asserted here; that the queue is flushed and not
          // dropped is covered by tests/unit/bootstrap (the stalled-stdout cases).
          expect(ids.length).toBeGreaterThan(0);
          expect(ids.length).toBeLessThanOrEqual(issued);
          expect(ids).toEqual(Array.from({ length: ids.length }, (_, index) => index + 1));
          expect(distinct(ids)).toBe(true);
          expect(server.strayLines()).toEqual([]);
        });
      },
      60_000,
    );

    // The client never reads again, so the bytes already handed to stdout stay queued and keep the
    // process alive: the shutdown gives up on them after the grace and the process is ended.
    it.skipIf(process.platform === "win32")(
      "exits on SIGTERM within the bound even when the client never resumes reading",
      async () => {
        await withUnreadServer(compiled, async (server) => {
          const { stalled } = await server.floodUntilStalled(FLOOD_LIMIT);

          expect(stalled).toBe(true);

          const start = Date.now();

          server.kill("SIGTERM");

          const exit = await withinLimit(server.exited, "exit after SIGTERM with stdout stalled");

          expect(exit).toEqual({ code: 143, signal: null });
          expect(Date.now() - start).toBeLessThan(15_000);
          // Logs are silent here; that the give-up is reported, with counts, is covered by
          // tests/unit/bootstrap/serve-mcp-shutdown.test.ts and by the blocked-write cases.
          expect(server.strayLines()).toEqual([]);
        });
      },
      60_000,
    );

    it("never writes anything but JSON-RPC to stdout under pressure", async () => {
      await withUnreadServer(compiled, async (server) => {
        const { stalled } = await server.floodUntilStalled(FLOOD_LIMIT);

        expect(stalled).toBe(true);
        server.startReading();
        await waitForAnswers(() => server.answeredIds(), server.issued(), "answers");

        expect(server.strayLines()).toEqual([]);
        expect(server.stderrText()).toBe("");
      });
    }, 60_000);
  });
}
