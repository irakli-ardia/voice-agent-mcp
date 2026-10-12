import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createBoundedStderr,
  startHelperProcess,
  windowsWriterSink,
} from "../../../../src/adapters/logging/bounded-stderr.js";

/**
 * The Windows sink's lifecycle against REAL helper processes (a helper is plain node, so this runs on
 * any platform): it cannot start, it exits at once, it closes its input and stays alive, and a normal
 * end. Each of them must cost a bounded number of processes and fail writes instead of waiting.
 */
function counting(start: () => ChildProcess) {
  const children: ChildProcess[] = [];

  const sink = windowsWriterSink({
    spawnHelper: () => {
      const child = start();

      children.push(child);

      return child;
    },
    onProcessExit: () => undefined,
  });

  return { sink, children };
}

const write = async (
  sink: ReturnType<typeof windowsWriterSink>,
  text: string,
): Promise<Error | null | undefined> =>
  new Promise((resolve) => {
    sink.write(Buffer.from(text), resolve);
  });

/** Writes until a write fails; a helper that is gone fails them at once or after its pipe closes. */
async function untilFailure(sink: ReturnType<typeof windowsWriterSink>): Promise<void> {
  await expect
    .poll(async () => (await write(sink, "line\n")) instanceof Error, {
      timeout: 10_000,
      interval: 25,
    })
    .toBe(true);
}

describe("windowsWriterSink with real helper processes", () => {
  it("fails writes, without throwing or starting another process, when the helper cannot start", async () => {
    const { sink, children } = counting(() =>
      spawn("a-command-that-does-not-exist-9f3a", [], { stdio: ["pipe", "ignore", "ignore"] }),
    );

    await untilFailure(sink);
    expect(await write(sink, "again\n")).toBeInstanceOf(Error);
    expect(children).toHaveLength(1);
  });

  it("fails writes once the helper has exited by itself, and starts no second one", async () => {
    const { sink, children } = counting(() =>
      spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "ignore", "ignore"] }),
    );

    await untilFailure(sink);
    expect(children).toHaveLength(1);
  });

  it("stays bounded when the helper closes its input and stays alive, and close still ends it", async () => {
    // Whether the pipe reports the loss or just stops taking data, the queue must not grow.
    const { sink, children } = counting(() =>
      spawn(process.execPath, ["-e", "require('fs').closeSync(0); setTimeout(() => {}, 30000)"], {
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );

    const stderr = createBoundedStderr({ sink });

    const line = `{"level":30,"msg":"${"x".repeat(100)}"}
`;

    for (let count = 0; count < 4_000; count += 1) {
      stderr.write(line);
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(stderr.queuedBytes()).toBeLessThanOrEqual(65_536 + 65_536);
    expect(children).toHaveLength(1);

    await stderr.flush(300);

    // The kill is asked for before flush returns; the process is gone a moment later.
    await expect
      .poll(() => children[0]?.exitCode !== null || children[0]?.signalCode !== null, {
        timeout: 5_000,
      })
      .toBe(true);
  });

  it("drops every line, with nothing queued and one process at most, however often it logs after the helper failed", async () => {
    const { sink, children } = counting(() =>
      spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["pipe", "ignore", "ignore"] }),
    );

    const stderr = createBoundedStderr({ sink });

    for (let count = 0; count < 5_000; count += 1) {
      stderr.write('{"level":30,"msg":"after the helper failed"}\n');
    }

    await stderr.flush(2_000);

    expect(stderr.queuedBytes()).toBe(0);
    expect(children).toHaveLength(1);
  });

  it("leaves no helper behind after an orderly end", async () => {
    const { sink, children } = counting(startHelperProcess);

    expect(
      await write(sink, '{"level":30,"msg":"bounded-stderr test: orderly end"}\n'),
    ).toBeFalsy();
    await sink.close?.(5_000);

    expect(children).toHaveLength(1);
    expect(children[0]?.exitCode !== null || children[0]?.signalCode !== null).toBe(true);
  });
});
