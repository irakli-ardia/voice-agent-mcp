import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { onFirstInterrupt } from "../../../src/entrypoints/interrupt.js";

describe("onFirstInterrupt", () => {
  it("aborts on the first SIGINT and then leaves SIGINT to the default behaviour", () => {
    const source = new EventEmitter();
    const controller = new AbortController();

    onFirstInterrupt(source, controller);

    expect(source.listenerCount("SIGINT")).toBe(1);
    source.emit("SIGINT");
    expect(controller.signal.aborted).toBe(true);
    expect(source.listenerCount("SIGINT")).toBe(0);
  });

  it("removes its listener when no signal arrived", () => {
    const source = new EventEmitter();
    const controller = new AbortController();

    onFirstInterrupt(source, controller)();

    expect(source.listenerCount("SIGINT")).toBe(0);
    source.emit("SIGINT");
    expect(controller.signal.aborted).toBe(false);
  });
});
