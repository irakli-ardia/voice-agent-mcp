import { createServer, type Server } from "node:http";
import { APIUserAbortError, type ClientOptions } from "openai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenAiClient } from "../../../../src/adapters/openai/openai-client.js";
import { createOpenAiSpeechToText } from "../../../../src/adapters/openai/openai-speech-to-text.js";
import type { AudioFormat } from "../../../../src/domain/audio-format.js";
import type { JsonValue } from "../../../../src/domain/json-value.js";
import type { AudioClip, SpeechToText } from "../../../../src/ports/speech-to-text.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import {
  createFakeFetch,
  type FakeExchange,
  type FakeFetch,
  jsonResponse,
} from "../../../helpers/fake-fetch.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";
import { untilAborted } from "../../../helpers/until-aborted.js";

const API_KEY = "sk-test-key-SECRET";

const SENTINEL = "SENTINEL-51ce";

type Fetch = NonNullable<ClientOptions["fetch"]>;

interface HarnessOptions {
  readonly maxRetries?: number;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly fetch?: Fetch;
}

interface Harness {
  readonly stt: SpeechToText;
  readonly http: FakeFetch;
  readonly logger: RecordingLogger;
  readonly sleeps: number[];
}

function harness(exchanges: readonly FakeExchange[], options: HarnessOptions = {}): Harness {
  const http = createFakeFetch(exchanges);
  const logger = createRecordingLogger();
  const sleeps: number[] = [];

  const stt = createOpenAiSpeechToText({
    client: createOpenAiClient({
      apiKey: API_KEY,
      timeoutMs: options.timeoutMs ?? 60_000,
      fetch: options.fetch ?? http.fetch,
    }),
    model: "gpt-transcribe",
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

  return { stt, http, logger, sleeps };
}

function clip(format: AudioFormat = "wav", bytes = new Uint8Array([1, 2, 3, 4, 5])): AudioClip {
  return { bytes, format };
}

function transcribed(body: JsonValue): FakeExchange {
  return () => jsonResponse(200, body);
}

const OK = transcribed({ text: "What time is it?", usage: { type: "duration", seconds: 3 } });

function apiError(
  status: number,
  code: string | null,
  headers: Readonly<Record<string, string>> = {},
): FakeExchange {
  return () =>
    jsonResponse(
      status,
      { error: { message: `PROVIDER-MESSAGE ${SENTINEL}`, type: "error", code, param: null } },
      headers,
    );
}

const connectionFailure: FakeExchange = () => new TypeError(`fetch failed ${SENTINEL}`);

function live(): AbortSignal {
  return new AbortController().signal;
}

function eventFields(logger: RecordingLogger): readonly unknown[] {
  return logger.entries.map(({ message, fields }) => ({ message, ...fields }));
}

function uploadedFile(http: FakeFetch, index = 0): File {
  const file = http.requests[index]?.form?.get("file");

  if (!(file instanceof File)) {
    throw new Error("no file was uploaded");
  }

  return file;
}

/** A listening TCP server's address: its port. */
const tcpAddressSchema = z.object({ port: z.number().int().positive() });

describe("OpenAI speech-to-text: the request", () => {
  it("posts only the configured model and the audio to the transcription endpoint", async () => {
    const h = harness([OK]);

    expect(await h.stt.transcribe(clip(), live())).toEqual({ ok: true, value: "What time is it?" });

    const request = h.http.requests[0];

    expect(h.http.requests).toHaveLength(1);
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect([...(request?.form?.keys() ?? [])]).toEqual(["model", "file"]);
    expect(request?.form?.get("model")).toBe("gpt-transcribe");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  });

  it.each([
    ["wav", "audio.wav", "audio/wav"],
    ["mp3", "audio.mp3", "audio/mpeg"],
    ["mp4", "audio.mp4", "audio/mp4"],
    ["webm", "audio.webm", "audio/webm"],
  ] as const)("uploads %s audio as the synthetic file %s (%s)", async (format, name, type) => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4]);
    const h = harness([OK]);

    await h.stt.transcribe(clip(format, bytes), live());

    const file = uploadedFile(h.http);

    expect(file.name).toBe(name);
    expect(file.type).toBe(type);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it("sends nothing about the local file: no path, no original name", async () => {
    const h = harness([OK]);

    await h.stt.transcribe(clip(), live());

    const request = h.http.requests[0];

    const sent = JSON.stringify({
      url: request?.url,
      headers: [...(request?.headers.entries() ?? [])],
      fields: [...(request?.form?.entries() ?? [])].map(([key, value]) =>
        value instanceof File ? [key, value.name, value.type] : [key, value],
      ),
    });

    expect(sent).not.toMatch(/question|Users|\\|\.\.\//);
    expect(uploadedFile(h.http).name).toBe("audio.wav");
  });

  it("returns the text exactly as given; blankness and length are the application's rules", async () => {
    for (const text of ["", "  spaced \n", "x".repeat(50_000)]) {
      const h = harness([transcribed({ text })]);

      expect(await h.stt.transcribe(clip(), live())).toEqual({ ok: true, value: text });
    }
  });
});

describe("OpenAI speech-to-text: response validation", () => {
  it.each([
    ["no text", { usage: { type: "duration", seconds: 1 } }],
    ["text that is a number", { text: 42 }],
    ["text that is null", { text: null }],
    ["an array", [{ text: "hi" }]],
    ["a bare string", "What time is it?"],
  ])(
    "rejects a success body with %s as a protocol error, without retrying",
    async (_name, body) => {
      const h = harness([transcribed(body)]);

      expect(await h.stt.transcribe(clip(), live())).toEqual({
        ok: false,
        error: { code: "protocol_error" },
      });
      expect(h.http.requests).toHaveLength(1);
      expect(eventFields(h.logger)).toEqual([
        expect.objectContaining({
          message: "stt.request_failed",
          outcome: "protocol_error",
          problem: "invalid_response",
          attempts: 1,
        }),
      ]);
    },
  );

  it("rejects a body that is not JSON as a protocol error, without retrying", async () => {
    const h = harness([
      () =>
        new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
    ]);

    expect(await h.stt.transcribe(clip(), live())).toEqual({
      ok: false,
      error: { code: "protocol_error" },
    });
    expect(h.http.requests).toHaveLength(1);
  });

  it("rejects a plain-text body as a protocol error", async () => {
    const h = harness([
      () =>
        new Response("What time is it?", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
    ]);

    expect(await h.stt.transcribe(clip(), live())).toEqual({
      ok: false,
      error: { code: "protocol_error" },
    });
  });

  it("ignores extra fields and a malformed usage: the transcription still succeeds", async () => {
    const h = harness([
      transcribed({ text: "Hi.", languages: [{ code: "en" }], usage: { type: "tokens" } }),
    ]);

    expect(await h.stt.transcribe(clip(), live())).toEqual({ ok: true, value: "Hi." });
    expect(eventFields(h.logger)[0]).not.toHaveProperty("inputTokens");
  });

  it.each([
    [{ type: "duration", seconds: 3 }, { audioSeconds: 3 }],
    [
      { type: "tokens", input_tokens: 40, output_tokens: 6, total_tokens: 46 },
      { inputTokens: 40, outputTokens: 6 },
    ],
  ])("logs usage counts %j", async (usage, fields) => {
    const h = harness([transcribed({ text: "Hi.", usage })]);

    await h.stt.transcribe(clip("mp3", new Uint8Array(12)), live());

    expect(eventFields(h.logger)).toEqual([
      {
        message: "stt.request_completed",
        provider: "openai",
        model: "gpt-transcribe",
        attempts: 1,
        durationMs: 0,
        format: "mp3",
        inputBytes: 12,
        outcome: "ok",
        ...fields,
      },
    ]);
  });
});

describe("OpenAI speech-to-text: failures and retries", () => {
  it.each([
    ["a connection failure", connectionFailure],
    ["408", apiError(408, null)],
    ["409", apiError(409, null)],
    ["429 rate limit", apiError(429, "rate_limit_exceeded")],
    ["500", apiError(500, null)],
    ["503", apiError(503, null)],
  ])("retries %s up to the limit, then reports unavailable", async (_name, exchange) => {
    const h = harness([exchange, exchange, exchange], { maxRetries: 2 });

    expect(await h.stt.transcribe(clip(), live())).toEqual({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(h.http.requests).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 500]);
  });

  it.each([
    ["429 insufficient_quota", apiError(429, "insufficient_quota")],
    ["400", apiError(400, "invalid_value")],
    ["400 context_length_exceeded", apiError(400, "context_length_exceeded")],
    ["401", apiError(401, "invalid_api_key")],
    ["403", apiError(403, null)],
    ["404", apiError(404, "model_not_found")],
    ["413", apiError(413, null)],
  ])("does not retry %s and reports rejected", async (_name, exchange) => {
    const h = harness([exchange]);

    expect(await h.stt.transcribe(clip(), live())).toEqual({
      ok: false,
      error: { code: "rejected" },
    });
    expect(h.http.requests).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it("succeeds after a transient failure", async () => {
    const h = harness([apiError(503, null), OK]);

    expect(await h.stt.transcribe(clip(), live())).toEqual({ ok: true, value: "What time is it?" });
    expect(h.http.requests).toHaveLength(2);
    expect(eventFields(h.logger)[0]).toMatchObject({ attempts: 2, outcome: "ok" });
  });

  it("re-sends the same audio on a retry", async () => {
    const bytes = new Uint8Array([4, 4, 2]);
    const h = harness([apiError(500, null), OK]);

    await h.stt.transcribe(clip("webm", bytes), live());

    expect(new Uint8Array(await uploadedFile(h.http, 1).arrayBuffer())).toEqual(bytes);
    expect(uploadedFile(h.http, 1).name).toBe("audio.webm");
  });

  it("waits as long as Retry-After asks, within the bound", async () => {
    const h = harness([apiError(429, null, { "retry-after-ms": "1200" }), OK]);

    expect((await h.stt.transcribe(clip(), live())).ok).toBe(true);
    expect(h.sleeps).toEqual([1_200]);
  });

  it("stops retrying when Retry-After asks for more than the bound", async () => {
    const h = harness([apiError(429, null, { "retry-after": "11" })]);

    expect(await h.stt.transcribe(clip(), live())).toEqual({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(h.http.requests).toHaveLength(1);
  });

  it("makes exactly one request with retries off: the SDK never retries on its own", async () => {
    const h = harness([apiError(500, null)], { maxRetries: 0 });

    expect(await h.stt.transcribe(clip(), live())).toEqual({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(h.http.requests).toHaveLength(1);
  });

  it("logs a failure with status and a sanitised provider code only", async () => {
    const h = harness([apiError(401, "invalid_api_key")]);

    await h.stt.transcribe(clip(), live());

    expect(eventFields(h.logger)).toEqual([
      {
        message: "stt.request_failed",
        provider: "openai",
        model: "gpt-transcribe",
        attempts: 1,
        durationMs: 0,
        format: "wav",
        inputBytes: 5,
        outcome: "rejected",
        httpStatus: 401,
        providerCode: "invalid_api_key",
        problem: undefined,
      },
    ]);
  });
});

describe("OpenAI speech-to-text: cancellation and timeouts", () => {
  it("rejects for a caller that already cancelled, sending nothing", async () => {
    const controller = new AbortController();
    const h = harness([OK]);

    controller.abort();

    await expect(h.stt.transcribe(clip(), controller.signal)).rejects.toBeInstanceOf(
      APIUserAbortError,
    );
    expect(h.http.requests).toHaveLength(0);
    expect(h.logger.entries).toEqual([]);
  });

  it("rejects when the caller (or the speech deadline) aborts during the request, without retrying", async () => {
    const controller = new AbortController();

    const h = harness([
      () => {
        queueMicrotask(() => controller.abort());

        return "hang";
      },
      OK,
    ]);

    await expect(h.stt.transcribe(clip(), controller.signal)).rejects.toBeInstanceOf(
      APIUserAbortError,
    );
    expect(h.http.requests).toHaveLength(1);
  });

  it("rejects when the caller aborts during a retry wait, sending nothing more", async () => {
    const controller = new AbortController();

    const h = harness([apiError(503, null), OK], {
      sleep: async (_ms, signal) => {
        controller.abort();

        return untilAborted(signal);
      },
    });

    await expect(h.stt.transcribe(clip(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(h.http.requests).toHaveLength(1);
  });

  it("retries a per-attempt timeout, then reports unavailable; the caller never aborted", async () => {
    const hang: FakeExchange = () => "hang";
    const h = harness([hang, hang], { maxRetries: 1, timeoutMs: 20 });

    expect(await h.stt.transcribe(clip(), live())).toEqual({
      ok: false,
      error: { code: "unavailable" },
    });
    expect(h.http.requests).toHaveLength(2);
  });

  it("keeps a response that completed before the caller aborted: the application decides", async () => {
    const controller = new AbortController();
    const h = harness([OK]);
    const result = await h.stt.transcribe(clip(), controller.signal);

    controller.abort();

    expect(result).toEqual({ ok: true, value: "What time is it?" });
  });
});

describe("OpenAI speech-to-text: a response body that stalls after its headers (real fetch)", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    server = undefined;
  });

  /** A local server that sends 200 and part of a JSON body, then never finishes. */
  async function stallingServer(): Promise<{ fetch: Fetch; headersSent: Promise<void> }> {
    const headersSent = Promise.withResolvers<void>();

    server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"te');
        headersSent.resolve();
      });
    });

    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));

    const { port } = tcpAddressSchema.parse(server.address());

    // The real platform fetch, pointed at the local server instead of api.openai.com.
    const fetch: Fetch = async (input, init) =>
      globalThis.fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init);

    return { fetch, headersSent: headersSent.promise };
  }

  it("is stopped by the caller's signal while the body is still arriving", async () => {
    const { fetch, headersSent } = await stallingServer();
    const controller = new AbortController();
    const h = harness([], { fetch, maxRetries: 0 });
    const result = h.stt.transcribe(clip(), controller.signal);

    await headersSent;
    controller.abort();

    await expect(result).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it("is bounded by the per-attempt timeout too: openai@7.28.0 times out a stalled JSON body", async () => {
    const { fetch, headersSent } = await stallingServer();
    const h = harness([], { fetch, maxRetries: 0, timeoutMs: 200 });
    const result = h.stt.transcribe(clip(), live());

    await headersSent;

    // No caller abort: the SDK races body parsing against the attempt's remaining timeout
    // (`parseResponseWithTimeout`) and fails with a connection timeout, which is transient.
    expect(await result).toEqual({ ok: false, error: { code: "unavailable" } });
  });
});

describe("OpenAI speech-to-text: privacy", () => {
  it("never logs the audio, the transcription, the key, or provider messages", async () => {
    const audio = new TextEncoder().encode(`RIFF ${SENTINEL} audio`);

    for (const exchange of [
      transcribed({ text: `Your note ${SENTINEL}` }),
      apiError(400, null),
      connectionFailure,
      transcribed({ text: 7, detail: SENTINEL }),
    ]) {
      const h = harness([exchange], { maxRetries: 0 });

      await h.stt.transcribe(clip("wav", audio), live());

      const logged = JSON.stringify(h.logger.entries);

      expect(h.logger.entries).toHaveLength(1);
      expect(logged).not.toContain(SENTINEL);
      expect(logged).not.toContain(API_KEY);
      expect(logged).not.toContain("audio.wav");
    }
  });
});
