import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/config.js";

const DEFAULTS = { logLevel: "info", maxToolResultBytes: 16_384 };

describe("loadConfig", () => {
  it("applies defaults when nothing is set", () => {
    expect(loadConfig({})).toEqual({ ok: true, config: DEFAULTS });
  });

  it("accepts a valid log level", () => {
    expect(loadConfig({ LOG_LEVEL: "debug" })).toEqual({
      ok: true,
      config: { ...DEFAULTS, logLevel: "debug" },
    });
  });

  it("ignores unrelated variables", () => {
    expect(loadConfig({ PATH: "/usr/bin", LOG_LEVEL: "warn" })).toEqual({
      ok: true,
      config: { ...DEFAULTS, logLevel: "warn" },
    });
  });

  it("rejects an invalid value without echoing it", () => {
    const result = loadConfig({ LOG_LEVEL: "sk-should-not-appear" });
    expect(result.ok).toBe(false);

    if (result.ok) {
      return;
    }

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatch(/^LOG_LEVEL: /);
    expect(result.issues.join("\n")).not.toContain("sk-should-not-appear");
  });

  it.each(["1", "1048576"])("accepts the tool result cap %s", (value) => {
    expect(loadConfig({ MAX_TOOL_RESULT_BYTES: value })).toEqual({
      ok: true,
      config: { ...DEFAULTS, maxToolResultBytes: Number(value) },
    });
  });

  it.each(["0", "1048577", "1.5", "-1", "", "lots"])("rejects the tool result cap %j", (value) => {
    const result = loadConfig({ MAX_TOOL_RESULT_BYTES: value });
    expect(result).toEqual({
      ok: false,
      issues: [expect.stringMatching(/^MAX_TOOL_RESULT_BYTES: /)],
    });
  });

  it("does not echo a rejected tool result cap", () => {
    const result = loadConfig({ MAX_TOOL_RESULT_BYTES: "sk-secret-cap" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("sk-secret-cap");
  });
});
