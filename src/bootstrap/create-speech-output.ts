import { createRealtimeTextToSpeech } from "../adapters/openai/realtime-text-to-speech.js";
import { createLocalAudioFiles } from "../adapters/persistence/local-audio-files.js";
import { systemClock } from "../adapters/system/system-clock.js";
import { createReserveSpeechOutput, type ReserveSpeechOutput } from "../app/audio/speech-output.js";
import type { OpenAiCredentials } from "../config/openai-credentials.js";
import { abortableSleep } from "./abortable-sleep.js";
import type { Application } from "./create-application.js";

/**
 * Composes speech output for `ask --speech-out`: an exclusively reserved local WAV file and the
 * OpenAI Realtime renderer. Built only for a command that speaks, after its credentials loaded.
 * Performs no I/O: the connection opens only when an answer is rendered.
 */
export function createSpeechOutput(
  application: Application,
  credentials: OpenAiCredentials,
): ReserveSpeechOutput {
  const { config, logger } = application;

  const textToSpeech = createRealtimeTextToSpeech({
    apiKey: credentials.apiKey,
    model: config.openai.ttsModel,
    voice: config.openai.ttsVoice,
    retry: { maxRetries: config.openai.maxRetries, random: Math.random, sleep: abortableSleep },
    clock: systemClock,
    logger,
  });

  return createReserveSpeechOutput({
    files: createLocalAudioFiles({ logger }),
    textToSpeech,
    clock: systemClock,
    logger,
    timeoutMs: config.speech.timeoutMs,
  });
}
