import { z } from "zod";

const logLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

export type LogLevel = z.output<typeof logLevelSchema>;

const configSchema = z
  .object({
    LOG_LEVEL: logLevelSchema.default("info"),
  })
  .transform((env) => ({
    logLevel: env.LOG_LEVEL,
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
