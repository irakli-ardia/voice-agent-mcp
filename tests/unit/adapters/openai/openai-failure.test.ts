import { APIConnectionTimeoutError, APIError, APIUserAbortError } from "openai";
import { describe, expect, it } from "vitest";
import { classifyOpenAiError } from "../../../../src/adapters/openai/openai-failure.js";

const idle = (): AbortSignal => new AbortController().signal;

describe("classifyOpenAiError", () => {
  it("rethrows any error once the signal has aborted", () => {
    const controller = new AbortController();
    controller.abort();
    const error = APIError.generate(500, undefined, undefined, new Headers());

    expect(() => classifyOpenAiError(error, controller.signal)).toThrow(error);
  });

  it("retries a per-attempt timeout", () => {
    expect(classifyOpenAiError(new APIConnectionTimeoutError(), idle())).toEqual({
      retry: true,
      value: { code: "unavailable", httpStatus: null, providerCode: null },
      retryAfterMs: undefined,
    });
  });

  it("treats an SDK abort that our signal did not cause as a protocol error", () => {
    expect(classifyOpenAiError(new APIUserAbortError(), idle()).value.code).toBe("protocol_error");
  });

  it("treats any other error as a protocol error, without retrying", () => {
    expect(classifyOpenAiError(new SyntaxError("Unexpected token"), idle())).toEqual({
      retry: false,
      value: { code: "protocol_error", httpStatus: null, providerCode: null },
    });
  });

  it("classifies by code, never by message text", () => {
    const misleading = APIError.generate(
      400,
      { error: { message: "context_length_exceeded insufficient_quota", code: "invalid_value" } },
      undefined,
      new Headers(),
    );

    expect(classifyOpenAiError(misleading, idle()).value).toEqual({
      code: "rejected",
      httpStatus: 400,
      providerCode: "invalid_value",
    });
  });
});
