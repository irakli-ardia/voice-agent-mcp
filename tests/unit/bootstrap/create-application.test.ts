import { describe, expect, it } from "vitest";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import type { Config } from "../../../src/config/config.js";

const CONFIG: Config = { logLevel: "silent", maxToolResultBytes: 16_384 };

describe("createApplication", () => {
  it("wires a logger for the given config", () => {
    const application = createApplication(CONFIG);
    expect(application.config).toEqual(CONFIG);
    expect(() => application.logger.child({ turnId: "t-1" }).info("ready")).not.toThrow();
  });

  it("registers the canonical tools", () => {
    expect(createApplication(CONFIG).tools.tools.map((tool) => tool.name)).toEqual([
      "get_current_time",
      "calculate",
    ]);
  });

  it("runs a registered tool through the executor with the system clock", async () => {
    const { executeTool } = createApplication(CONFIG);
    const signal = new AbortController().signal;

    const sum = await executeTool(
      { id: "call-1", name: "calculate", arguments: { operation: "add", a: 2, b: 3 } },
      signal,
    );

    const time = await executeTool(
      { id: "call-2", name: "get_current_time", arguments: { timeZone: null } },
      signal,
    );

    expect(sum).toEqual({ ok: true, value: { result: 5 } });
    expect(time).toEqual({
      ok: true,
      value: expect.objectContaining({ timeZone: "UTC", isoTime: expect.stringMatching(/Z$/) }),
    });
  });

  it("applies the configured result size cap", async () => {
    const { executeTool } = createApplication({ ...CONFIG, maxToolResultBytes: 5 });

    const result = await executeTool(
      { id: "call-1", name: "calculate", arguments: { operation: "add", a: 2, b: 3 } },
      new AbortController().signal,
    );

    expect(result.ok ? "ok" : result.error.code).toBe("output_too_large");
  });
});
