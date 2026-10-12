import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { windowsWriterSink } from "../../../../src/adapters/logging/bounded-stderr.js";

/** A stand-in for the helper process, so the sink is tested without starting one. */
class FakeHelper extends ChildProcess {
  override stdin = new PassThrough();

  killed_ = 0;

  unrefs = 0;

  override unref(): void {
    this.unrefs += 1;
  }

  override kill(): boolean {
    this.killed_ += 1;
    this.emit("exit", 1);

    return true;
  }
}

function setup() {
  const helpers: FakeHelper[] = [];
  const exitListeners: (() => void)[] = [];

  const sink = windowsWriterSink({
    spawnHelper: () => {
      const helper = new FakeHelper();

      helpers.push(helper);

      return helper;
    },
    onProcessExit: (listener) => {
      exitListeners.push(listener);
    },
  });

  return { sink, helpers, exitListeners };
}

const write = async (
  sink: ReturnType<typeof windowsWriterSink>,
  text: string,
): Promise<Error | null | undefined> =>
  new Promise((resolve) => {
    sink.write(Buffer.from(text), resolve);
  });

describe("windowsWriterSink with a stand-in helper", () => {
  it("starts one helper however many lines are written", async () => {
    const { sink, helpers } = setup();

    await write(sink, "a\n");
    await write(sink, "b\n");
    await write(sink, "c\n");

    expect(helpers).toHaveLength(1);
  });

  it("does not start a helper until the first line", () => {
    const { helpers } = setup();

    expect(helpers).toHaveLength(0);
  });

  it("does not keep this process alive for the helper", async () => {
    const { sink, helpers } = setup();

    await write(sink, "a\n");

    expect(helpers[0]?.unrefs).toBe(1);
  });

  it("fails further writes, instead of waiting, once the helper has exited", async () => {
    const { sink, helpers } = setup();

    await write(sink, "a\n");
    helpers[0]?.emit("exit", 1);

    expect(await write(sink, "b\n")).toBeInstanceOf(Error);
    expect(helpers).toHaveLength(1);
  });

  it("fails further writes once the helper reports an error, and does not start another", async () => {
    const { sink, helpers } = setup();

    await write(sink, "a\n");
    helpers[0]?.emit("error", new Error("spawn failed"));

    expect(await write(sink, "b\n")).toBeInstanceOf(Error);
    expect(helpers).toHaveLength(1);
  });

  it("fails writes, and does not try again, when the helper cannot be started", async () => {
    let attempts = 0;

    const sink = windowsWriterSink({
      spawnHelper: () => {
        attempts += 1;

        throw new Error("no process");
      },
      onProcessExit: () => undefined,
    });

    expect(await write(sink, "a\n")).toBeInstanceOf(Error);
    expect(await write(sink, "b\n")).toBeInstanceOf(Error);
    expect(attempts).toBe(1);
  });

  it("ends the helper input and then the helper on close, waiting for it at most the time given", async () => {
    const { sink, helpers } = setup();

    await write(sink, "a\n");

    const closing = sink.close?.(5_000);

    expect(helpers[0]?.stdin.writableEnded).toBe(true);
    helpers[0]?.emit("exit", 0);
    await closing;

    expect(helpers[0]?.killed_).toBe(1);
  });

  it("gives up on a helper that does not end, and kills it", async () => {
    const { sink, helpers } = setup();

    await write(sink, "a\n");
    await sink.close?.(20);

    expect(helpers[0]?.killed_).toBe(1);
  });

  it("lets the helper finish when this process exits with every line handed over", async () => {
    const { sink, helpers, exitListeners } = setup();

    await write(sink, "a\n");
    exitListeners[0]?.();

    expect(helpers[0]?.stdin.writableEnded).toBe(true);
    expect(helpers[0]?.killed_).toBe(0);
  });

  it("kills the helper when this process exits while a line is still being handed over", async () => {
    const { sink, helpers, exitListeners } = setup();

    await write(sink, "a\n");

    // The pipe to the helper is full and nobody reads it: the helper is stuck behind its reader.
    helpers[0]?.stdin.pause();
    sink.write(Buffer.alloc(1_000_000), () => undefined);
    exitListeners[0]?.();

    expect(helpers[0]?.killed_).toBe(1);
  });
});
