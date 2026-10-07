import { APIConnectionError, APIError } from "openai";
import type { AttemptOutcome } from "./retry-policy.js";

/**
 * How a failed OpenAI request is classified, for every endpoint. Each adapter maps these onto its
 * own port's failure codes.
 */
export type OpenAiFailureCode = "unavailable" | "rejected" | "context_too_large" | "protocol_error";

/** What a failed request may contribute to a log event: a status and a sanitised code, no text. */
export interface OpenAiFailure {
  readonly code: OpenAiFailureCode;
  readonly httpStatus: number | null;
  readonly providerCode: string | null;
}

/** Provider error codes are logged only in this form; anything else is logged as `null`. */
const PROVIDER_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const milliseconds = Number.parseFloat(headers?.get("retry-after-ms") ?? "");

  if (Number.isFinite(milliseconds) && milliseconds >= 0) {
    return milliseconds;
  }

  // HTTP-date values are not honoured: the backoff applies instead.
  const seconds = Number.parseFloat(headers?.get("retry-after") ?? "");

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

/** Request timeout, lock conflict, and rate limit; every 5xx is transient too. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 409, 429]);

/** A failure for an HTTP status; `transient` failures are retried. */
interface StatusFailure {
  readonly code: OpenAiFailureCode;
  readonly transient: boolean;
}

/** An HTTP status and provider error code to a model failure. */
function failureCodeFor(status: number, code: string | null): StatusFailure {
  if (status === 429 && code === "insufficient_quota") {
    return { code: "rejected", transient: false };
  }

  if (TRANSIENT_STATUSES.has(status) || status >= 500) {
    return { code: "unavailable", transient: true };
  }

  return status === 400 && code === "context_length_exceeded"
    ? { code: "context_too_large", transient: false }
    : { code: "rejected", transient: false };
}

function apiFailure(error: APIError, status: number): AttemptOutcome<OpenAiFailure> {
  const code = error.code ?? null;
  const classified = failureCodeFor(status, code);

  const value: OpenAiFailure = {
    code: classified.code,
    httpStatus: status,
    providerCode: code !== null && PROVIDER_CODE_PATTERN.test(code) ? code : null,
  };

  return classified.transient
    ? { retry: true, value, retryAfterMs: retryAfterMs(error.headers) }
    : { retry: false, value };
}

/**
 * Classifies a failed request by HTTP status, error class, and error `code` — never by message
 * text. Rethrows when `signal` aborted, because the port rejects only for an abort. A failure that
 * is not an API or connection error (the response arrived but could not be used) is a protocol
 * error and is not retried.
 */
export function classifyOpenAiError(
  error: Error,
  signal: AbortSignal,
): AttemptOutcome<OpenAiFailure> {
  if (signal.aborted) {
    throw error;
  }

  // Includes the per-attempt timeout (`APIConnectionTimeoutError` extends it).
  if (error instanceof APIConnectionError) {
    return {
      retry: true,
      value: { code: "unavailable", httpStatus: null, providerCode: null },
      retryAfterMs: undefined,
    };
  }

  if (error instanceof APIError && error.status !== undefined) {
    return apiFailure(error, error.status);
  }

  return { retry: false, value: { code: "protocol_error", httpStatus: null, providerCode: null } };
}

/**
 * The outcome of an attempt whose request threw: classified as above (so it rethrows when `signal`
 * aborted), with the failure wrapped as the calling adapter's own attempt value.
 */
export function failedAttempt<T>(
  cause: unknown,
  signal: AbortSignal,
  wrap: (failure: OpenAiFailure) => T,
): AttemptOutcome<T> {
  const outcome = classifyOpenAiError(
    cause instanceof Error ? cause : new Error("non-error thrown"),
    signal,
  );

  const value = wrap(outcome.value);

  return outcome.retry ? { ...outcome, value } : { retry: false, value };
}
