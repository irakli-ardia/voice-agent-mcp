import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/config/config.js";

const AGENT_DEFAULTS = {
  maxIterations: 8,
  maxToolCallsPerTurn: 16,
  maxInputTextChars: 4_000,
  turnTimeoutMs: 120_000,
};

const OPENAI_DEFAULTS = {
  model: "gpt-6-luna",
  timeoutMs: 60_000,
  maxRetries: 2,
  maxOutputTokens: 4_096,
  reasoningEffort: "none",
};

const DEFAULTS = {
  logLevel: "info",
  maxToolResultBytes: 16_384,
  dataDir: resolve(".data"),
  agent: AGENT_DEFAULTS,
  openai: OPENAI_DEFAULTS,
};

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

  it("resolves DATA_DIR to an absolute path once, against the working directory", () => {
    expect(loadConfig({ DATA_DIR: "some/notes-dir" })).toEqual({
      ok: true,
      config: { ...DEFAULTS, dataDir: resolve("some/notes-dir") },
    });
    expect(loadConfig({ DATA_DIR: resolve("/srv/voice-agent") })).toEqual({
      ok: true,
      config: { ...DEFAULTS, dataDir: resolve("/srv/voice-agent") },
    });
  });

  it("rejects an empty DATA_DIR", () => {
    expect(loadConfig({ DATA_DIR: "" })).toEqual({
      ok: false,
      issues: [expect.stringMatching(/^DATA_DIR: /)],
    });
  });

  describe.each([
    ["MAX_AGENT_ITERATIONS", "maxIterations", ["1", "32"], ["0", "33"]],
    ["MAX_TOOL_CALLS_PER_TURN", "maxToolCallsPerTurn", ["1", "128"], ["0", "129"]],
    ["MAX_INPUT_TEXT_CHARS", "maxInputTextChars", ["1", "32000"], ["0", "32001"]],
    ["AGENT_TURN_TIMEOUT_MS", "turnTimeoutMs", ["5000", "600000"], ["4999", "600001"]],
  ] as const)("%s", (variable, field, accepted, outOfRange) => {
    it.each(accepted)("accepts the bound %s", (value) => {
      expect(loadConfig({ [variable]: value })).toEqual({
        ok: true,
        config: { ...DEFAULTS, agent: { ...AGENT_DEFAULTS, [field]: Number(value) } },
      });
    });

    it.each([...outOfRange, "1.5", "-1", "", "many"])(
      "rejects %j, naming only the variable",
      (value) => {
        expect(loadConfig({ [variable]: value })).toEqual({
          ok: false,
          issues: [expect.stringMatching(new RegExp(`^${variable}: `))],
        });
      },
    );

    it("does not echo a rejected value", () => {
      expect(JSON.stringify(loadConfig({ [variable]: "sk-secret-limit" }))).not.toContain(
        "sk-secret-limit",
      );
    });
  });

  describe.each([
    ["OPENAI_TIMEOUT_MS", "timeoutMs", ["1000", "600000"], ["999", "600001", "1.5"]],
    ["OPENAI_MAX_RETRIES", "maxRetries", ["0", "5"], ["-1", "6", "1.5"]],
    ["OPENAI_MAX_OUTPUT_TOKENS", "maxOutputTokens", ["256", "32768"], ["255", "32769", "1.5"]],
  ] as const)("%s", (variable, field, accepted, rejected) => {
    it.each(accepted)("accepts the bound %s", (value) => {
      expect(loadConfig({ [variable]: value })).toEqual({
        ok: true,
        config: { ...DEFAULTS, openai: { ...OPENAI_DEFAULTS, [field]: Number(value) } },
      });
    });

    it.each([...rejected, "", "many"])("rejects %j, naming only the variable", (value) => {
      expect(loadConfig({ [variable]: value })).toEqual({
        ok: false,
        issues: [expect.stringMatching(new RegExp(`^${variable}: `))],
      });
    });
  });

  it.each(["gpt-6-luna", "gpt-5.4-mini-2026-03-17", "ft:gpt-4.1:org:name:id"])(
    "accepts the model id %s",
    (model) => {
      expect(loadConfig({ OPENAI_MODEL: model })).toEqual({
        ok: true,
        config: { ...DEFAULTS, openai: { ...OPENAI_DEFAULTS, model } },
      });
    },
  );

  it.each(["", "has space", "x".repeat(65), "sk-proj/secret-model"])(
    "rejects the model id %j without echoing it",
    (model) => {
      const result = loadConfig({ OPENAI_MODEL: model });

      expect(result).toEqual({ ok: false, issues: [expect.stringMatching(/^OPENAI_MODEL: /)] });
      expect(JSON.stringify(result).includes(model)).toBe(model === "");
    },
  );

  it.each(["none", "low"])("accepts the reasoning effort %s", (effort) => {
    expect(loadConfig({ OPENAI_REASONING_EFFORT: effort })).toEqual({
      ok: true,
      config: { ...DEFAULTS, openai: { ...OPENAI_DEFAULTS, reasoningEffort: effort } },
    });
  });

  it.each(["medium", "high", "", "NONE"])("rejects the reasoning effort %j", (effort) => {
    expect(loadConfig({ OPENAI_REASONING_EFFORT: effort })).toEqual({
      ok: false,
      issues: [expect.stringMatching(/^OPENAI_REASONING_EFFORT: /)],
    });
  });

  it("never reads or requires OPENAI_API_KEY", () => {
    expect(loadConfig({ OPENAI_API_KEY: "sk-test-key" })).toEqual({ ok: true, config: DEFAULTS });
  });
});
