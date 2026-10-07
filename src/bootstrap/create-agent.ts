import { createOpenAiClient } from "../adapters/openai/openai-client.js";
import { createResponsesAgentModel } from "../adapters/openai/responses-agent-model.js";
import { systemClock } from "../adapters/system/system-clock.js";
import { systemIdGenerator } from "../adapters/system/system-id-generator.js";
import { type AgentRunner, createAgentRunner } from "../app/agent/agent-runner.js";
import type { OpenAiCredentials } from "../config/openai-credentials.js";
import { abortableSleep } from "./abortable-sleep.js";
import type { Application } from "./create-application.js";

/**
 * Composes the agent for a command that calls OpenAI, on top of the canonical tools and executor.
 * Built only after the command has loaded its credentials, so commands that never call OpenAI need
 * no key. Performs no I/O.
 */
export function createAgent(application: Application, credentials: OpenAiCredentials): AgentRunner {
  const { config, logger } = application;

  const model = createResponsesAgentModel({
    client: createOpenAiClient({ apiKey: credentials.apiKey, timeoutMs: config.openai.timeoutMs }),
    model: config.openai.model,
    maxOutputTokens: config.openai.maxOutputTokens,
    reasoningEffort: config.openai.reasoningEffort,
    retry: { maxRetries: config.openai.maxRetries, random: Math.random, sleep: abortableSleep },
    clock: systemClock,
    logger,
  });

  return createAgentRunner({
    model,
    registry: application.tools,
    executeTool: application.executeTool,
    ids: systemIdGenerator,
    clock: systemClock,
    logger,
    limits: config.agent,
  });
}
