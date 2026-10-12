import { posix, resolve, win32 } from "node:path";
import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export type LogLevel = z.output<typeof logLevelSchema>;

/** Provider model ids: letters, digits, and `._:-`, so an id is safe in a URL query and a log. */
const modelIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/);

/** The built-in voices the OpenAI Realtime API documents; custom voice ids are not supported. */
const voiceSchema = z.enum([
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
]);

const configSchema = z
  .object({
    LOG_LEVEL: logLevelSchema.default("info"),
    MAX_TOOL_RESULT_BYTES: z.coerce.number().int().min(1).max(1_048_576).default(16_384),
    MAX_NOTES: z.coerce.number().int().min(1).max(1_000_000).default(10_000),
    MAX_ABANDONED_TOOL_HANDLERS: z.coerce.number().int().min(1).max(64).default(3),
    DATA_DIR: z.string().min(1).default(".data"),
    MAX_AGENT_ITERATIONS: z.coerce.number().int().min(1).max(32).default(8),
    MAX_TOOL_CALLS_PER_TURN: z.coerce.number().int().min(1).max(128).default(16),
    MAX_INPUT_TEXT_CHARS: z.coerce.number().int().min(1).max(32_000).default(4_000),
    AGENT_TURN_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(120_000),
    OPENAI_MODEL: modelIdSchema.default("gpt-6-luna"),
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
    OPENAI_STT_MODEL: modelIdSchema.default("gpt-transcribe"),
    OPENAI_TTS_MODEL: modelIdSchema.default("gpt-realtime-2.1-mini"),
    OPENAI_TTS_VOICE: voiceSchema.default("marin"),
    SPEECH_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(600_000).default(180_000),
    MCP_MAX_IN_FLIGHT_CALLS: z.coerce.number().int().min(1).max(128).default(16),
    MCP_MAX_CALLS_PER_SECOND: z.coerce.number().int().min(1).max(1_000).default(20),
  })
  .transform((env) => ({
    logLevel: env.LOG_LEVEL,
    maxToolResultBytes: env.MAX_TOOL_RESULT_BYTES,
    /** Tool handlers the executor stopped waiting for that may still run before new calls are refused. */
    maxAbandonedToolHandlers: env.MAX_ABANDONED_TOOL_HANDLERS,
    /** The most notes the store holds; a create past it fails with `note_quota_exceeded`. */
    maxNotes: env.MAX_NOTES,
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
      /** Speech-to-text model for audio input. */
      sttModel: env.OPENAI_STT_MODEL,
      /** Realtime model that renders the final answer as speech. */
      ttsModel: env.OPENAI_TTS_MODEL,
      ttsVoice: env.OPENAI_TTS_VOICE,
    },
    speech: {
      /** One budget per speech operation: every step, attempt, wait, and byte received. */
      timeoutMs: env.SPEECH_TIMEOUT_MS,
    },
    mcp: {
      /** Concurrent `tools/call` requests being executed; more are refused with `server_busy`. */
      maxInFlightCalls: env.MCP_MAX_IN_FLIGHT_CALLS,
      /** Sustained `tools/call` rate and burst capacity of one server process; more get `rate_limited`. */
      maxCallsPerSecond: env.MCP_MAX_CALLS_PER_SECOND,
    },
  }));

export type Config = Readonly<z.output<typeof configSchema>>;

export type ConfigResult =
  | { readonly ok: true; readonly config: Config }
  | { readonly ok: false; readonly issues: readonly string[] };

/** How a command wants `DATA_DIR`: the CLI's default and any path, or the server's explicit absolute path. */
export interface LoadConfigOptions {
  /**
   * `explicit-absolute`: `DATA_DIR` must be set to an absolute path, and the default is refused. The
   * MCP server uses it, because a host starts it in a directory the user did not choose, and a
   * relative or default path would put notes there. Otherwise the CLI behaviour is unchanged.
   */
  readonly dataDir?: "default" | "explicit-absolute";
}

/** Characters no Windows path component may contain; `:` after the drive names an NTFS stream. */
const WINDOWS_ILLEGAL = /[<>"|?*:]/;

/** `\\.\`: the device namespace (`\\.\pipe\x`), which is not a directory on a disk. */
const DEVICE_NAMESPACE = /^[\\/]{2}\.[\\/]/;

/** `C:\` or `C:/`: a drive and a separator, so not the current directory of a drive (`C:x`). */
const DRIVE_ROOT = /^[A-Za-z]:[\\/]$/;

/** `\\server\share`: a UNC share. */
const SHARE_ROOT = /^[\\/]{2}[^\\/?]+[\\/][^\\/]+[\\/]?$/;

/** `\\?\C:\`: a verbatim drive path. */
const VERBATIM_DRIVE = /^\\\\\?\\[A-Za-z]:\\/;

/**
 * Whether `value` names one place whatever the working directory is. Windows: a drive and a
 * separator (`C:\x`, `C:/x`), a UNC share, or a verbatim drive path; not `\x` (the current drive)
 * and not `C:x` (a drive's current directory). POSIX: a leading `/`. A NUL byte is never valid, and
 * on Windows neither are `< > " | ? *` after the drive or share.
 */
export function isExplicitAbsolutePath(value: string, flavor: "windows" | "posix"): boolean {
  if (value.includes("\0")) {
    return false;
  }

  if (flavor === "posix") {
    return posix.isAbsolute(value);
  }

  if (VERBATIM_DRIVE.test(value)) {
    return !WINDOWS_ILLEGAL.test(value.slice(6));
  }

  if (DEVICE_NAMESPACE.test(value)) {
    return false;
  }

  const { root } = win32.parse(value);

  if (!(DRIVE_ROOT.test(root) || SHARE_ROOT.test(root))) {
    return false;
  }

  return !WINDOWS_ILLEGAL.test(value.slice(DRIVE_ROOT.test(root) ? 2 : root.length));
}

/** The reasons `DATA_DIR` fails the explicit-absolute policy; never the value. */
function dataDirIssues(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") {
    return ["DATA_DIR: must be set to an absolute directory path for this command"];
  }

  const flavor = process.platform === "win32" ? "windows" : "posix";

  return isExplicitAbsolutePath(value, flavor)
    ? []
    : ["DATA_DIR: must be an absolute path for this command (not relative, not drive-relative)"];
}

/**
 * The only reader of `process.env`. Parses once at startup; issues name the variable and the
 * rule, never the rejected value, so a misplaced secret cannot reach the terminal.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: LoadConfigOptions = {},
): ConfigResult {
  const policy = options.dataDir === "explicit-absolute" ? dataDirIssues(env["DATA_DIR"]) : [];
  const parsed = configSchema.safeParse(env);

  if (parsed.success && policy.length === 0) {
    return { ok: true, config: parsed.data };
  }

  return {
    ok: false,
    issues: [
      ...policy,
      ...(parsed.success
        ? []
        : parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)),
    ],
  };
}
