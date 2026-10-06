import OpenAI, { type ClientOptions } from "openai";

export interface OpenAiClientOptions {
  readonly apiKey: string;
  /** Per HTTP attempt. */
  readonly timeoutMs: number;
  /** The HTTP transport; tests inject one, production uses the platform `fetch`. */
  readonly fetch?: ClientOptions["fetch"];
}

/** The only endpoint this application talks to. */
const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Builds the OpenAI client with every environment-backed option set explicitly, so the SDK does not
 * pick up `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_ADMIN_KEY`,
 * `OPENAI_WEBHOOK_SECRET`, or `OPENAI_LOG` from the process environment (it reads them only for
 * options left `undefined`). Retries are ours, so the SDK's are off. Known residual: the SDK still
 * merges headers from `OPENAI_CUSTOM_HEADERS` into every request, and no supported option turns
 * that off.
 */
export function createOpenAiClient(options: OpenAiClientOptions): OpenAI {
  return new OpenAI({
    apiKey: options.apiKey,
    baseURL: OPENAI_BASE_URL,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    logLevel: "off",
    maxRetries: 0,
    timeout: options.timeoutMs,
    // `undefined` keeps the platform `fetch`.
    fetch: options.fetch,
  });
}
