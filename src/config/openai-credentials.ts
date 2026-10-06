import { z } from "zod";

const credentialsSchema = z
  .object({ OPENAI_API_KEY: z.string().min(1, "is required for this command") })
  .transform((env) => ({ apiKey: env.OPENAI_API_KEY }));

/** The OpenAI secret. Loaded only by commands that call OpenAI, never kept in `Config`. */
export type OpenAiCredentials = Readonly<z.output<typeof credentialsSchema>>;

export type OpenAiCredentialsResult =
  | { readonly ok: true; readonly credentials: OpenAiCredentials }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Reads `OPENAI_API_KEY` for a command that needs it, so `--help` and `tools` work without one.
 * Issues name the variable, never its value.
 */
export function loadOpenAiCredentials(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenAiCredentialsResult {
  const parsed = credentialsSchema.safeParse(env);

  if (parsed.success) {
    return { ok: true, credentials: parsed.data };
  }

  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) =>
        `${issue.path.join(".")}: ${issue.code === "invalid_type" ? "is required for this command" : issue.message}`,
    ),
  };
}
