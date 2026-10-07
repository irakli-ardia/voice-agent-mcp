import type { AgentRunner } from "../app/agent/agent-runner.js";
import type { ReserveSpeechOutput } from "../app/audio/speech-output.js";
import type { TranscribeAudio } from "../app/audio/transcribe-audio.js";
import type { Config } from "../config/config.js";
import type { OpenAiCredentials } from "../config/openai-credentials.js";
import { createAgent } from "./create-agent.js";
import { type Application, createApplication } from "./create-application.js";
import { createSpeechOutput } from "./create-speech-output.js";
import { createTranscriber } from "./create-transcriber.js";

/**
 * How the CLI builds what a command needs. The application holds the canonical tools and executor
 * and never depends on OpenAI; the agent, the transcriber, and the speech output are each composed
 * only by a command that uses them, after it has loaded its credentials. Tests pass their own
 * composition (fakes behind these factories) through this seam.
 */
export interface Composition {
  createApplication(config: Config): Application;
  createAgent(application: Application, credentials: OpenAiCredentials): AgentRunner;
  createTranscriber(application: Application, credentials: OpenAiCredentials): TranscribeAudio;
  createSpeechOutput(application: Application, credentials: OpenAiCredentials): ReserveSpeechOutput;
}

export const productionComposition: Composition = {
  createApplication,
  createAgent,
  createTranscriber,
  createSpeechOutput,
};
