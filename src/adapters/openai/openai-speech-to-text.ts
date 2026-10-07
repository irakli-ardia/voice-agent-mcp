import { type OpenAI, toFile } from "openai";
import { z } from "zod";
import type { AudioFormat } from "../../domain/audio-format.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { Clock } from "../../ports/clock.js";
import type { LogFields, Logger } from "../../ports/logger.js";
import type {
  AudioClip,
  SpeechServiceFailure,
  SpeechServiceFailureCode,
  SpeechToText,
} from "../../ports/speech-to-text.js";
import { failedAttempt, type OpenAiFailure, type OpenAiFailureCode } from "./openai-failure.js";
import { type AttemptOutcome, type RetryPolicy, runWithRetries } from "./retry-policy.js";

export interface OpenAiSpeechToTextOptions {
  readonly client: OpenAI;
  /** `OPENAI_STT_MODEL`. */
  readonly model: string;
  readonly retry: RetryPolicy;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * The upload's file name and type, from the format recognised in the bytes. The name is synthetic:
 * the user's file name and path never leave the machine; the provider reads the format from it.
 */
const UPLOADS = {
  wav: { name: "audio.wav", type: "audio/wav" },
  mp3: { name: "audio.mp3", type: "audio/mpeg" },
  mp4: { name: "audio.mp4", type: "audio/mp4" },
  webm: { name: "audio.webm", type: "audio/webm" },
} satisfies { readonly [Format in AudioFormat]: { readonly name: string; readonly type: string } };

const FAILURES = {
  unavailable: "unavailable",
  rejected: "rejected",
  // Not produced by this endpoint's classification; a 400 of any kind is a rejection here.
  context_too_large: "rejected",
  protocol_error: "protocol_error",
} satisfies { readonly [Code in OpenAiFailureCode]: SpeechServiceFailureCode };

/** Usage as the endpoint reports it, kept only for log counts. */
const usageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tokens"),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("duration"), seconds: z.number().nonnegative() }),
]);

/**
 * The part of a successful response this application uses; other fields are ignored. A missing or
 * malformed `usage` only drops the log counts, it never fails a transcription.
 */
const transcriptionSchema = z.object({
  text: z.string(),
  usage: usageSchema.optional().catch(undefined),
});

type Transcription = z.output<typeof transcriptionSchema>;

function usageFields(usage: Transcription["usage"]): LogFields {
  if (usage === undefined) {
    return {};
  }

  return usage.type === "tokens"
    ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }
    : { audioSeconds: usage.seconds };
}

type AttemptResult =
  | { readonly kind: "transcription"; readonly transcription: Transcription }
  | { readonly kind: "failure"; readonly failure: OpenAiFailure; readonly problem?: string };

/** A response that arrived but is not a transcription: never retried. */
const INVALID_RESPONSE: AttemptResult = {
  kind: "failure",
  failure: { code: "protocol_error", httpStatus: null, providerCode: null },
  problem: "invalid_response",
};

async function attempt(
  options: OpenAiSpeechToTextOptions,
  file: File,
  signal: AbortSignal,
): Promise<AttemptOutcome<AttemptResult>> {
  try {
    const response = await options.client.audio.transcriptions.create(
      { model: options.model, file },
      { signal, maxRetries: 0 },
    );

    const parsed = transcriptionSchema.safeParse(response);

    return {
      retry: false,
      value: parsed.success
        ? { kind: "transcription", transcription: parsed.data }
        : INVALID_RESPONSE,
    };
  } catch (cause) {
    return failedAttempt(cause, signal, (failure): AttemptResult => ({ kind: "failure", failure }));
  }
}

/**
 * `SpeechToText` over the OpenAI transcription endpoint. The request carries only the model and the
 * audio as `audio.<format>`: no response format (the default is the JSON object validated here), no
 * language hint, no prompt. Transient failures are retried by the shared policy with SDK retries
 * off; the promise rejects only when `signal` aborts, which also stops a response body that is
 * still arriving. Logs one event per call with metadata only — never audio, file names, or text.
 */
export function createOpenAiSpeechToText(options: OpenAiSpeechToTextOptions): SpeechToText {
  return {
    transcribe: async (
      audio: AudioClip,
      signal: AbortSignal,
    ): Promise<Result<string, SpeechServiceFailure>> => {
      const startedAt = options.clock.monotonicNow();
      const upload = UPLOADS[audio.format];
      const file = await toFile(audio.bytes, upload.name, { type: upload.type });

      const { value, attempts } = await runWithRetries(
        () => attempt(options, file, signal),
        options.retry,
        signal,
      );

      const base: LogFields = {
        provider: "openai",
        model: options.model,
        attempts,
        durationMs: options.clock.monotonicNow() - startedAt,
        format: audio.format,
        inputBytes: audio.bytes.byteLength,
      };

      if (value.kind === "failure") {
        const { code, httpStatus, providerCode } = value.failure;
        const failure = FAILURES[code];

        options.logger.warn("stt.request_failed", {
          ...base,
          outcome: failure,
          httpStatus,
          providerCode,
          problem: value.problem,
        });

        return err({ code: failure });
      }

      options.logger.info("stt.request_completed", {
        ...base,
        outcome: "ok",
        ...usageFields(value.transcription.usage),
      });

      return ok(value.transcription.text);
    },
  };
}
