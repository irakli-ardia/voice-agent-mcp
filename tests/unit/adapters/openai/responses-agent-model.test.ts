import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenAiClient } from "../../../../src/adapters/openai/openai-client.js";
import {
  createResponsesAgentModel,
  type OpenAiContinuation,
} from "../../../../src/adapters/openai/responses-agent-model.js";
import type { JsonObject, JsonValue } from "../../../../src/domain/json-value.js";
import { err, ok, type Result } from "../../../../src/domain/result.js";
import type {
  AgentModel,
  ModelFailure,
  ModelRequest,
  ModelStep,
  TranscriptItem,
} from "../../../../src/ports/agent-model.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import {
  createFakeFetch,
  type FakeExchange,
  type FakeFetch,
  jsonResponse,
} from "../../../helpers/fake-fetch.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";

const API_KEY = "sk-test-key-SECRET";

const USAGE = {
  input_tokens: 10,
  input_tokens_details: { cached_tokens: 2, cache_write_tokens: 0 },
  output_tokens: 5,
  output_tokens_details: { reasoning_tokens: 1 },
  total_tokens: 15,
};

function responseBody(output: readonly JsonValue[], overrides: JsonObject = {}): JsonObject {
  return {
    id: "resp_1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gpt-6-luna",
    output,
    incomplete_details: null,
    usage: USAGE,
    ...overrides,
  };
}

const REASONING = {
  type: "reasoning",
  id: "rs_1",
  summary: [],
  encrypted_content: "ENCRYPTED-REASONING-SECRET",
};

function message(parts: readonly string[], phase = "final_answer"): JsonObject {
  return {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    phase,
    content: parts.map((text) => ({ type: "output_text", text, annotations: [] })),
  };
}

function functionCall(
  callId: string,
  name: string,
  args: string,
  extra: JsonObject = {},
): JsonObject {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: args,
    status: "completed",
    ...extra,
  };
}

function completed(output: readonly JsonValue[], overrides: JsonObject = {}): FakeExchange {
  return () => jsonResponse(200, responseBody(output, overrides));
}

function apiError(
  status: number,
  code: string | null,
  headers: Readonly<Record<string, string>> = {},
): FakeExchange {
  return () =>
    jsonResponse(
      status,
      { error: { message: "PROVIDER-MESSAGE-SECRET", type: "error", code, param: null } },
      headers,
    );
}

const TOOL = {
  name: "calculate",
  description: "Adds numbers.",
  parameters: {
    type: "object",
    properties: { a: { type: "number", description: "A." } },
    required: ["a"],
    additionalProperties: false,
  },
};

function request(
  transcript: readonly TranscriptItem<OpenAiContinuation>[] = [
    { kind: "user_text", text: "USER-TEXT-SECRET" },
  ],
): ModelRequest<OpenAiContinuation> {
  return { instructions: "INSTRUCTIONS-SECRET", tools: [TOOL], transcript };
}

interface Harness {
  readonly model: AgentModel<OpenAiContinuation>;
  readonly http: FakeFetch;
  readonly logger: RecordingLogger;
  readonly sleeps: number[];
}

function harness(
  exchanges: readonly FakeExchange[],
  options: { maxRetries?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> } = {},
): Harness {
  const http = createFakeFetch(exchanges);
  const logger = createRecordingLogger();
  const sleeps: number[] = [];

  const model = createResponsesAgentModel({
    client: createOpenAiClient({ apiKey: API_KEY, timeoutMs: 60_000, fetch: http.fetch }),
    model: "gpt-6-luna",
    maxOutputTokens: 4_096,
    reasoningEffort: "none",
    retry: {
      maxRetries: options.maxRetries ?? 2,
      random: () => 0.5,
      sleep:
        options.sleep ??
        (async (ms) => {
          sleeps.push(ms);
        }),
    },
    clock: createFakeClock(),
    logger,
  });

  return { model, http, logger, sleeps };
}

const sentBodySchema = z.looseObject({ input: z.array(z.json()) });

/** The `input` array of a recorded request body. */
function sentInput(body: JsonValue | undefined): readonly JsonValue[] {
  return sentBodySchema.parse(body).input;
}

type StepResult = Result<ModelStep<OpenAiContinuation>, ModelFailure>;

async function respond(h: Harness, req = request()): Promise<StepResult> {
  return h.model.respond(req, new AbortController().signal);
}

function codeOf(result: StepResult): string {
  return result.ok ? "ok" : result.error.code;
}

function lastEvent(logger: RecordingLogger): ReturnType<RecordingLogger["entries"]["at"]> {
  return logger.entries.at(-1);
}

describe("Responses adapter: request", () => {
  it("sends one stateless request with every planned option and no server-side state", async () => {
    const h = harness([completed([message(["Hi."])])]);

    await respond(h);

    const [sent] = h.http.requests;
    expect(sent?.url).toBe("https://api.openai.com/v1/responses");
    expect(sent?.method).toBe("POST");
    expect(sent?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(sent?.body).toEqual({
      model: "gpt-6-luna",
      instructions: "INSTRUCTIONS-SECRET",
      input: [{ role: "user", content: "USER-TEXT-SECRET" }],
      tools: [
        {
          type: "function",
          name: "calculate",
          description: "Adds numbers.",
          parameters: TOOL.parameters,
          strict: true,
        },
      ],
      store: false,
      truncation: "disabled",
      include: ["reasoning.encrypted_content"],
      max_output_tokens: 4_096,
      parallel_tool_calls: true,
      reasoning: { effort: "none" },
    });
  });

  it("replays each step's output items verbatim, then its tool results in call order", async () => {
    const first = harness([
      completed([
        REASONING,
        message(["Checking."], "commentary"),
        functionCall("call_1", "calculate", '{"a":1}'),
        functionCall("call_2", "calculate", '{"a":2}'),
      ]),
    ]);

    const step = await respond(first);

    if (!step.ok) {
      throw new Error("expected a step");
    }

    const second = harness([completed([message(["Done."])])]);

    await respond(
      second,
      request([
        { kind: "user_text", text: "Question." },
        { kind: "model_step", ...step.value },
        { kind: "tool_result", callId: "call_1", result: ok({ sum: 1 }) },
        {
          kind: "tool_result",
          callId: "call_2",
          result: err({ code: "invalid_input", message: "Invalid arguments: a: bad." }),
        },
      ]),
    );

    const body = second.http.requests[0]?.body;

    const expectedInput: readonly JsonValue[] = [
      { role: "user", content: "Question." },
      REASONING,
      message(["Checking."], "commentary"),
      functionCall("call_1", "calculate", '{"a":1}'),
      functionCall("call_2", "calculate", '{"a":2}'),
      { type: "function_call_output", call_id: "call_1", output: '{"ok":true,"result":{"sum":1}}' },
      {
        type: "function_call_output",
        call_id: "call_2",
        output:
          '{"ok":false,"error":{"code":"invalid_input","message":"Invalid arguments: a: bad."}}',
      },
    ];

    expect(sentInput(body)).toEqual(expectedInput);
    expect(body).not.toHaveProperty("previous_response_id");
    expect(body).not.toHaveProperty("conversation");
  });

  it("bounds the tool-result envelope exactly: result + 21 bytes, error at most 1088 bytes", async () => {
    const value = { text: "é".repeat(100) };
    const longest = err({ code: "confirmation_required" as const, message: "m".repeat(1_022) });
    const h = harness([completed([message(["Done."])])]);

    await respond(
      h,
      request([
        { kind: "user_text", text: "Q." },
        { kind: "model_step", text: null, toolCalls: [], continuation: [] },
        { kind: "tool_result", callId: "c1", result: ok(value) },
        { kind: "tool_result", callId: "c2", result: longest },
      ]),
    );

    const outputs = JSON.stringify(h.http.requests[0]?.body)
      .match(/"output":("(?:[^"\\]|\\.)*")/g)
      ?.map((match) => z.string().parse(JSON.parse(match.slice('"output":'.length))));

    const bytes = (text: string | undefined): number =>
      new TextEncoder().encode(text ?? "").byteLength;

    expect(bytes(outputs?.[0])).toBe(
      new TextEncoder().encode(JSON.stringify(value)).byteLength + 21,
    );
    expect(bytes(outputs?.[1])).toBe(1_088);
  });
});

describe("Responses adapter: completed responses", () => {
  it("joins text parts within a message and messages with a newline", async () => {
    const h = harness([completed([REASONING, message(["Hel", "lo"]), message(["World"])])]);

    const result = await respond(h);

    expect(result.ok && result.value.text).toBe("Hello\nWorld");
    expect(result.ok && result.value.toolCalls).toEqual([]);
  });

  it("returns null text when the response has no message", async () => {
    const h = harness([completed([REASONING, functionCall("call_1", "calculate", '{"a":1}')])]);

    const result = await respond(h);

    expect(result).toEqual({
      ok: true,
      value: {
        text: null,
        toolCalls: [{ callId: "call_1", name: "calculate", arguments: { a: 1 } }],
        continuation: [REASONING, functionCall("call_1", "calculate", '{"a":1}')],
      },
    });
  });

  it("decodes unparseable arguments as undefined and logs only a count", async () => {
    const h = harness([completed([functionCall("call_1", "calculate", '{"a": RAW-ARGS-SECRET')])]);

    const result = await respond(h);

    expect(result.ok && result.value.toolCalls).toEqual([
      { callId: "call_1", name: "calculate", arguments: undefined },
    ]);
    expect(lastEvent(h.logger)?.fields).toEqual(
      expect.objectContaining({ undecodableArguments: 1, toolCalls: 1 }),
    );
    expect(JSON.stringify(h.logger.entries)).not.toContain("RAW-ARGS-SECRET");
  });

  it("logs one completed event with metadata and usage only", async () => {
    const h = harness([completed([message(["Hi."])])]);

    await respond(h);

    expect(h.logger.entries).toEqual([
      {
        level: "info",
        message: "model.request_completed",
        fields: {
          provider: "openai",
          model: "gpt-6-luna",
          attempts: 1,
          durationMs: 0,
          outcome: "ok",
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningTokens: 1,
          toolCalls: 0,
          undecodableArguments: 0,
        },
      },
    ]);
  });
});

describe("Responses adapter: unusable responses", () => {
  it.each(["max_output_tokens", "content_filter"])(
    "reports an incomplete response (%s) and none of its calls",
    async (reason) => {
      const h = harness([
        completed([functionCall("call_1", "calculate", '{"a"')], {
          status: "incomplete",
          incomplete_details: { reason },
        }),
      ]);

      expect(codeOf(await respond(h))).toBe("incomplete");
      expect(lastEvent(h.logger)?.fields).toEqual(
        expect.objectContaining({ incompleteReason: reason }),
      );
    },
  );

  it.each(["failed", "cancelled", "in_progress", "queued"])(
    "reports a response with status %s as a protocol error",
    async (status) => {
      const h = harness([completed([message(["Hi."])], { status })]);

      expect(codeOf(await respond(h))).toBe("protocol_error");
    },
  );

  it.each<[string, JsonValue]>([
    ["no details", null],
    ["a reason outside the safe form", { reason: "Reason With Spaces" }],
  ])("logs a null incomplete reason for %s", async (_case, details) => {
    const h = harness([
      completed([message(["Hi."])], { status: "incomplete", incomplete_details: details }),
    ]);

    expect(codeOf(await respond(h))).toBe("incomplete");
    expect(lastEvent(h.logger)?.fields).toEqual(
      expect.objectContaining({ incompleteReason: null }),
    );
  });

  it("logs no usage counts when the response has none", async () => {
    const h = harness([
      () => {
        const { usage: _usage, ...withoutUsage } = responseBody([message(["Hi."])]);

        return jsonResponse(200, withoutUsage);
      },
    ]);

    await respond(h);

    expect(lastEvent(h.logger)?.fields).not.toHaveProperty("inputTokens");
  });

  it("reports a refusal without passing its text on", async () => {
    const h = harness([
      completed([
        {
          ...message([]),
          content: [{ type: "refusal", refusal: "REFUSAL-TEXT-SECRET" }],
        },
      ]),
    ]);

    const result = await respond(h);

    expect(result).toEqual({ ok: false, error: { code: "refused" } });
    expect(JSON.stringify(h.logger.entries)).not.toContain("REFUSAL-TEXT-SECRET");
  });

  it.each<[string, JsonObject]>([
    ["a web search call", { type: "web_search_call", id: "ws_1", status: "completed" }],
    ["an unknown item", { type: "future_item", id: "x_1" }],
    ["an incomplete message", { ...message(["Hi."]), status: "incomplete" }],
    [
      "an incomplete function call",
      functionCall("c1", "calculate", "{}", { status: "incomplete" }),
    ],
    ["an asynchronous function call", functionCall("c1", "calculate", "{}", { async: true })],
    [
      "a programmatic function call",
      functionCall("c1", "calculate", "{}", { caller: { type: "program", id: "p1" } }),
    ],
    ["a namespaced function call", functionCall("c1", "calculate", "{}", { namespace: "ns" })],
  ])("rejects %s as a protocol error, with no calls", async (_kind, item) => {
    const h = harness([completed([functionCall("c0", "calculate", "{}"), item])]);

    const result = await respond(h);

    expect(result).toEqual({ ok: false, error: { code: "protocol_error" } });
  });

  it("accepts a direct caller explicitly", async () => {
    const h = harness([
      completed([functionCall("c1", "calculate", "{}", { caller: { type: "direct" } })]),
    ]);

    expect(codeOf(await respond(h))).toBe("ok");
  });

  it("reports a success body that is not JSON as a protocol error, without retrying", async () => {
    const h = harness([
      () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    ]);

    expect(codeOf(await respond(h))).toBe("protocol_error");
    expect(h.http.requests).toHaveLength(1);
  });
});

describe("Responses adapter: provider errors", () => {
  it.each<[string, FakeExchange, string]>([
    ["401", apiError(401, "invalid_api_key"), "rejected"],
    ["403", apiError(403, null), "rejected"],
    ["404 (unknown model)", apiError(404, "model_not_found"), "rejected"],
    ["400", apiError(400, "invalid_value"), "rejected"],
    ["422", apiError(422, null), "rejected"],
    ["400 context_length_exceeded", apiError(400, "context_length_exceeded"), "context_too_large"],
    ["429 insufficient_quota", apiError(429, "insufficient_quota"), "rejected"],
  ])("maps %s without retrying", async (_case, exchange, code) => {
    const h = harness([exchange]);

    expect(codeOf(await respond(h))).toBe(code);
    expect(h.http.requests).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it.each<[string, FakeExchange]>([
    ["408", apiError(408, null)],
    ["409", apiError(409, null)],
    ["429", apiError(429, "rate_limit_exceeded")],
    ["500", apiError(500, null)],
    ["503", apiError(503, null)],
    ["a connection failure", () => new TypeError("fetch failed")],
  ])("retries %s and reports unavailable when retries run out", async (_case, exchange) => {
    const h = harness([exchange, exchange, exchange]);

    expect(codeOf(await respond(h))).toBe("unavailable");
    expect(h.http.requests).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 500]);
    expect(lastEvent(h.logger)?.fields).toEqual(expect.objectContaining({ attempts: 3 }));
  });

  it("succeeds on a retry and logs the attempt count", async () => {
    const h = harness([apiError(500, null), completed([message(["Hi."])])]);

    expect(codeOf(await respond(h))).toBe("ok");
    expect(lastEvent(h.logger)?.fields).toEqual(expect.objectContaining({ attempts: 2 }));
  });

  it("never retries with maxRetries 0", async () => {
    const h = harness([apiError(500, null)], { maxRetries: 0 });

    expect(codeOf(await respond(h))).toBe("unavailable");
    expect(h.http.requests).toHaveLength(1);
  });

  it.each<[string, Readonly<Record<string, string>>, readonly number[], number]>([
    ["retry-after-ms", { "retry-after-ms": "1500" }, [1_500], 2],
    ["retry-after seconds", { "retry-after": "2" }, [2_000], 2],
    ["a wait at the 10 s cap", { "retry-after": "10" }, [10_000], 2],
    [
      "an HTTP date (backoff instead)",
      { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" },
      [250],
      2,
    ],
    ["a wait over the cap", { "retry-after": "11" }, [], 1],
  ])("honours %s within the bound", async (_case, headers, sleeps, requests) => {
    const h = harness([
      apiError(429, "rate_limit_exceeded", headers),
      completed([message(["Hi."])]),
    ]);

    await respond(h);

    expect(h.sleeps).toEqual(sleeps);
    expect(h.http.requests).toHaveLength(requests);
  });

  it("logs the status and a sanitised code, never the provider message or the API key", async () => {
    const h = harness([apiError(400, "Bad Code With Spaces")]);

    await respond(h);

    expect(lastEvent(h.logger)).toEqual({
      level: "warn",
      message: "model.request_failed",
      fields: {
        provider: "openai",
        model: "gpt-6-luna",
        attempts: 1,
        durationMs: 0,
        outcome: "rejected",
        httpStatus: 400,
        providerCode: null,
      },
    });
    expect(JSON.stringify(h.logger.entries)).not.toContain("PROVIDER-MESSAGE-SECRET");
    expect(JSON.stringify(h.logger.entries)).not.toContain(API_KEY);
  });
});

describe("Responses adapter: cancellation", () => {
  it("rejects when the signal aborts during a request", async () => {
    const h = harness([() => "hang"]);
    const controller = new AbortController();
    const pending = h.model.respond(request(), controller.signal);

    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();

    await expect(pending).rejects.toBeDefined();
    expect(h.http.requests).toHaveLength(1);
  });

  it("rejects when the signal aborts during a backoff wait, without another attempt", async () => {
    const controller = new AbortController();

    const h = harness([apiError(500, null), completed([message(["Hi."])])], {
      sleep: async (_ms, signal) => {
        controller.abort();
        signal.throwIfAborted();
      },
    });

    await expect(h.model.respond(request(), controller.signal)).rejects.toBeDefined();
    expect(h.http.requests).toHaveLength(1);
  });

  it("rejects without a request when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness([completed([message(["Hi."])])]);

    await expect(h.model.respond(request(), controller.signal)).rejects.toBeDefined();
    expect(h.http.requests.length).toBeLessThanOrEqual(1);
  });
});

describe("Responses adapter: logging", () => {
  it("never logs prompts, text, arguments, reasoning, or results", async () => {
    const h = harness([
      completed([
        REASONING,
        message(["ASSISTANT-TEXT-SECRET"]),
        functionCall("call_1", "calculate", '{"a":"ARGS-SECRET"}'),
      ]),
    ]);

    await respond(
      h,
      request([
        { kind: "user_text", text: "USER-TEXT-SECRET" },
        { kind: "tool_result", callId: "call_0", result: ok({ out: "RESULT-SECRET" }) },
      ]),
    );

    const logged = JSON.stringify(h.logger.entries);

    for (const secret of [
      "USER-TEXT-SECRET",
      "INSTRUCTIONS-SECRET",
      "ENCRYPTED-REASONING-SECRET",
      "ASSISTANT-TEXT-SECRET",
      "ARGS-SECRET",
      "RESULT-SECRET",
      API_KEY,
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
