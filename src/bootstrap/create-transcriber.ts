import { createOpenAiClient } from "../adapters/openai/openai-client.js";
import { createOpenAiSpeechToText } from "../adapters/openai/openai-speech-to-text.js";
import { createLocalAudioFiles } from "../adapters/persistence/local-audio-files.js";
import { systemClock } from "../adapters/system/system-clock.js";
import { createTranscribeAudio, type TranscribeAudio } from "../app/audio/transcribe-audio.js";
import type { OpenAiCredentials } from "../config/openai-credentials.js";
import { abortableSleep } from "./abortable-sleep.js";
import type { Application } from "./create-application.js";

/**
 * Composes speech-to-text for `ask --audio`: local files read within the application limit, then
 * OpenAI transcription. Built only for a command that transcribes, after its credentials loaded.
 * The client's per-attempt timeout equals the speech deadline, which is armed first, so the
 * deadline always decides. Performs no I/O.
 */
export function createTranscriber(
  application: Application,
  credentials: OpenAiCredentials,
): TranscribeAudio {
  const { config, logger } = application;

  const speechToText = createOpenAiSpeechToText({
    client: createOpenAiClient({ apiKey: credentials.apiKey, timeoutMs: config.speech.timeoutMs }),
    model: config.openai.sttModel,
    retry: { maxRetries: config.openai.maxRetries, random: Math.random, sleep: abortableSleep },
    clock: systemClock,
    logger,
  });

  return createTranscribeAudio({
    files: createLocalAudioFiles({ logger }),
    speechToText,
    clock: systemClock,
    logger,
    limits: {
      maxTranscriptionChars: config.agent.maxInputTextChars,
      timeoutMs: config.speech.timeoutMs,
    },
  });
}
