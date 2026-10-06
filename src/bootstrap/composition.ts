import type { AgentRunner } from "../app/agent/agent-runner.js";
import type { Config } from "../config/config.js";
import type { OpenAiCredentials } from "../config/openai-credentials.js";
import { createAgent } from "./create-agent.js";
import { type Application, createApplication } from "./create-application.js";

/**
 * How the CLI builds what a command needs. The application holds the canonical tools and executor
 * and never depends on OpenAI; the agent is composed only by a command that calls the model, after
 * it has loaded its credentials. Tests pass their own composition (a fake model behind
 * `createAgent`) through this seam.
 */
export interface Composition {
  createApplication(config: Config): Application;
  createAgent(application: Application, credentials: OpenAiCredentials): AgentRunner;
}

export const productionComposition: Composition = { createApplication, createAgent };
