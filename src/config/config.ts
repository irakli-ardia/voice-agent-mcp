import { resolve } from "node:path";
import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export type LogLevel = z.output<typeof logLevelSchema>;

const configSchema = z
  .object({
    LOG_LEVEL: logLevelSchema.default("info"),
    MAX_TOOL_RESULT_BYTES: z.coerce.number().int().min(1).max(1_048_576).default(16_384),
    DATA_DIR: z.string().min(1).default(".data"),
    MAX_AGENT_ITERATIONS: z.coerce.number().int().min(1).max(32).default(8),
    MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().min(1).max(128).default(16),
    MAX_INPUT_TEXT_CHARS: z.coerce.number().int().min(1).max(32_000).default(4_000),
    AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
    OPENAI_MODEL: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{1,64}$/)
      .default("gpt-6-luna"),
    OPENAI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
    // Digits only: an empty value must not silently mean zero retries.
    OPENAI_MAX_RETRIES: z
      .string()
      .regex(/^\d+$/)
      .default("2")
      .transform(Number)
      .pipe(z.number().int().min(0).max(5)),
    OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_768).default(4_096),
    OPENAI_REASONING_EFFORT: z.enum(["none", "low"]).default("none"),
  })
  .transform((env) => ({
    logLevel: env.LOG_LEVEL,
    maxToolResultBytes: env.MAX_TOOL_RESULT_BYTES,
    /** Absolute, resolved once against the working directory at startup. */
    dataDir: resolve(env.DATA_DIR),
    agent: {
      /** Model invocations per turn, including the one that answers. */
      maxIterations: env.MAX_AGENT_ITERATIONS,
      maxToolCallsPerTurn: env.MAX_TOOL_CALLS_PER_TURN,
      /** User text length, in UTF-16 code units. */
      maxInputTextChars: env.MAX_INPUT_TEXT_CHARS,
      turnTimeoutMs: env.AGENT_TURN_TIMEOUT_MS,
    },
    /** Non-secret OpenAI settings; the API key is loaded only by commands that call OpenAI. */
    openai: {
      model: env.OPENAI_MODEL,
      /** Per HTTP attempt. */
      timeoutMs: env.OPENAI_TIMEOUT_MS,
      /** Retries of transient failures within one model invocation. */
      maxRetries: env.OPENAI_MAX_RETRIES,
      maxOutputTokens: env.OPENAI_MAX_OUTPUT_TOKENS,
      reasoningEffort: env.OPENAI_REASONING_EFFORT,
    },
  }));

export type Config = Readonly<z.output<typeof configSchema>>;

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The only reader of `process.env`. Parses once at startup; issues name the variable and the
 * rule, never the rejected value, so a misplaced secret cannot reach the terminal.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConfigResult {
  const parsed = configSchema.safeParse(env);

  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }

  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}
