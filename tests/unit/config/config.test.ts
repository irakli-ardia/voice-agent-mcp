import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/config.js";

describe("loadConfig", () => {
  it("defaults the log level to info", () => {
    expect(loadConfig({})).toEqual({ ok: true, config: { logLevel: "info" } });
  });

  it("accepts a valid log level", () => {
    expect(loadConfig({ LOG_LEVEL: "debug" })).toEqual({ ok: true, config: { logLevel: "debug" } });
  });

  it("ignores unrelated variables", () => {
    expect(loadConfig({ PATH: "/usr/bin", LOG_LEVEL: "warn" })).toEqual({
      ok: true,
      config: { logLevel: "warn" },
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
});
