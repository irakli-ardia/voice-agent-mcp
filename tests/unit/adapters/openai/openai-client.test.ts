import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiClient } from "../../../../src/adapters/openai/openai-client.js";
import { createFakeFetch, jsonResponse } from "../../../helpers/fake-fetch.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const BODY = {
  model: "gpt-6-luna",
  input: "Hi.",
  store: false,
};

describe("createOpenAiClient", () => {
  it("ignores OpenAI environment variables: endpoint, key, organisation, project, and logging", async () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://attacker.example/v1");
    vi.stubEnv("OPENAI_API_KEY", "sk-from-environment");
    vi.stubEnv("OPENAI_ORG_ID", "org-from-environment");
    vi.stubEnv("OPENAI_PROJECT_ID", "proj-from-environment");
    vi.stubEnv("OPENAI_ADMIN_KEY", "sk-admin-from-environment");
    vi.stubEnv("OPENAI_LOG", "debug");

    const consoleCalls = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ];

    const http = createFakeFetch([() => jsonResponse(200, { id: "resp_1", output: [] })]);

    await createOpenAiClient({
      apiKey: "sk-explicit",
      timeoutMs: 1_000,
      fetch: http.fetch,
    }).responses.create(BODY);

    const [sent] = http.requests;
    expect(sent?.url).toBe("https://api.openai.com/v1/responses");
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-explicit");
    expect(sent?.headers.has("openai-organization")).toBe(false);
    expect(sent?.headers.has("openai-project")).toBe(false);
    expect(JSON.stringify([...(sent?.headers.entries() ?? [])])).not.toContain("from-environment");

    for (const spy of consoleCalls) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("makes exactly one attempt: retries belong to the application", async () => {
    const http = createFakeFetch([
      () => jsonResponse(500, { error: { message: "x" } }),
      () => jsonResponse(200, { id: "resp_1", output: [] }),
    ]);

    await expect(
      createOpenAiClient({
        apiKey: "sk-explicit",
        timeoutMs: 1_000,
        fetch: http.fetch,
      }).responses.create(BODY),
    ).rejects.toMatchObject({ status: 500 });
    expect(http.requests).toHaveLength(1);
  });

  /**
   * Documents the known residual: the SDK merges `OPENAI_CUSTOM_HEADERS` into every request and
   * offers no supported option to turn that off. Whoever controls the environment can add headers.
   */
  it("still applies OPENAI_CUSTOM_HEADERS (documented residual)", async () => {
    vi.stubEnv("OPENAI_CUSTOM_HEADERS", "x-residual-check: present");
    const http = createFakeFetch([() => jsonResponse(200, { id: "resp_1", output: [] })]);

    await createOpenAiClient({
      apiKey: "sk-explicit",
      timeoutMs: 1_000,
      fetch: http.fetch,
    }).responses.create(BODY);

    expect(http.requests[0]?.headers.get("x-residual-check")).toBe("present");
  });
});
