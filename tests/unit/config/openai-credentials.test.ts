import { describe, expect, it } from "vitest";
import { loadOpenAiCredentials } from "../../../src/config/openai-credentials.js";

describe("loadOpenAiCredentials", () => {
  it("returns the API key", () => {
    expect(loadOpenAiCredentials({ OPENAI_API_KEY: "sk-test-key" })).toEqual({
      ok: true,
      credentials: { apiKey: "sk-test-key" },
    });
  });

  it.each([
    ["missing", {}],
    ["empty", { OPENAI_API_KEY: "" }],
  ])("names the variable when the key is %s", (_kind, env) => {
    expect(loadOpenAiCredentials(env)).toEqual({
      ok: false,
      issues: ["OPENAI_API_KEY: is required for this command"],
    });
  });

  it("ignores every other variable", () => {
    expect(loadOpenAiCredentials({ OPENAI_API_KEY: "sk-a", OPENAI_ORG_ID: "org-x" })).toEqual({
      ok: true,
      credentials: { apiKey: "sk-a" },
    });
  });
});
