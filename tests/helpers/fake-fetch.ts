import type { ClientOptions } from "openai";
import { z } from "zod";
import type { JsonValue } from "../../src/domain/json-value.js";

type Fetch = NonNullable<ClientOptions["fetch"]>;

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  /** The parsed JSON body, or `null` for a multipart request. */
  readonly body: JsonValue;
  /** The multipart body of an upload, as the SDK handed it to `fetch`; `null` for JSON. */
  readonly form: FormData | null;
}

/** One scripted HTTP exchange. Returning `"hang"` waits until the request is aborted. */
export type FakeExchange = (request: RecordedRequest) => Response | "hang" | Error;

export interface FakeFetch {
  readonly fetch: Fetch;
  readonly requests: readonly RecordedRequest[];
}

const bodySchema = z.string().transform((text) => z.json().parse(JSON.parse(text)));

export function jsonResponse(
  status: number,
  body: JsonValue,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function abortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

/** A multipart upload is kept as the SDK built it; anything else must be a JSON body. */
function recordBody(body: RequestInit["body"]): Pick<RecordedRequest, "body" | "form"> {
  return body instanceof FormData
    ? { body: null, form: body }
    : { body: bodySchema.parse(body ?? "null"), form: null };
}

function recordRequest(...[input, init]: Parameters<Fetch>): RecordedRequest {
  return {
    url: input instanceof Request ? input.url : String(input),
    method: init?.method ?? "GET",
    headers: new Headers(init?.headers),
    ...recordBody(init?.body),
  };
}

/** Plays one exchange the way `fetch` would: rejects on abort, throws an error, or responds. */
async function settle(
  exchange: FakeExchange,
  request: RecordedRequest,
  signal: AbortSignal | undefined,
): Promise<Response> {
  if (signal?.aborted === true) {
    throw abortError();
  }

  const outcome = exchange(request);

  if (outcome instanceof Error) {
    throw outcome;
  }

  if (outcome === "hang") {
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(abortError()), { once: true });
    });
  }

  return outcome;
}

/**
 * A `fetch` with no network behind it: each call takes the next scripted exchange and records the
 * request. A call past the end of the script fails the test.
 */
export function createFakeFetch(exchanges: readonly FakeExchange[]): FakeFetch {
  const requests: RecordedRequest[] = [];

  const send: Fetch = async (input, init) => {
    const request = recordRequest(input, init);
    const exchange = exchanges[requests.length];

    requests.push(request);

    if (exchange === undefined) {
      throw new Error(`Unscripted request ${requests.length}.`);
    }

    return settle(exchange, request, init?.signal ?? undefined);
  };

  // The SDK checks FormData support with `fetch.Response` when present, and otherwise by calling
  // `fetch("data:,")`, which would consume a scripted exchange.
  return { fetch: Object.assign(send, { Response }), requests };
}
