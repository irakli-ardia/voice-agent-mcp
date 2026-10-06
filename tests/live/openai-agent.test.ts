import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ResponseInputItem,
  ResponseReasoningItem,
} from "openai/resources/responses/responses";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createOpenAiClient } from "../../src/adapters/openai/openai-client.js";
import {
  createResponsesAgentModel,
  type OpenAiContinuation,
} from "../../src/adapters/openai/responses-agent-model.js";
import { systemClock } from "../../src/adapters/system/system-clock.js";
import { systemIdGenerator } from "../../src/adapters/system/system-id-generator.js";
import { AGENT_INSTRUCTIONS, createAgentRunner } from "../../src/app/agent/agent-runner.js";
import { withHostIdempotencyKey } from "../../src/app/agent/host-idempotency-key.js";
import { createModelTools } from "../../src/app/agent/model-tools.js";
import { createToolExecutor } from "../../src/app/tools/tool-executor.js";
import { type Application, createApplication } from "../../src/bootstrap/create-application.js";
import { type Config, loadConfig } from "../../src/config/config.js";
import { loadOpenAiCredentials } from "../../src/config/openai-credentials.js";
import { ok } from "../../src/domain/result.js";
import type { AgentModel } from "../../src/ports/agent-model.js";
import { defineTool, type ToolDefinition } from "../../src/tools/tool-definition.js";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.js";

/**
 * Live verification against the real OpenAI API (gates G1–G8 of the M3 plan). Opt-in: run with
 * `npm run test:openai`; needs OPENAI_API_KEY and spends API credits. Prompts are fixed and contain
 * no user data. Only safe metadata is printed: gate, model, outcome, counts, and latency.
 */
const configResult = loadConfig();

const credentialsResult = loadOpenAiCredentials();

if (!configResult.ok || !credentialsResult.ok) {
  throw new Error("The live suite needs a valid configuration and OPENAI_API_KEY.");
}

const config: Config = configResult.config;

const apiKey = credentialsResult.credentials.apiKey;

let dataDir = "";

let application: Application;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "voice-agent-live-"));
  application = createApplication({ ...config, dataDir });
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function model(
  logger: RecordingLogger,
  options: {
    readonly apiKey?: string;
    readonly model?: string;
    readonly effort?: "none" | "low";
  } = {},
): AgentModel<OpenAiContinuation> {
  return createResponsesAgentModel({
    client: createOpenAiClient({
      apiKey: options.apiKey ?? apiKey,
      timeoutMs: config.openai.timeoutMs,
    }),
    model: options.model ?? config.openai.model,
    maxOutputTokens: config.openai.maxOutputTokens,
    reasoningEffort: options.effort ?? config.openai.reasoningEffort,
    retry: {
      maxRetries: config.openai.maxRetries,
      random: Math.random,
      sleep: async (ms, signal) => {
        await delay(ms, undefined, { signal });
      },
    },
    clock: systemClock,
    logger,
  });
}

function runner(
  logger: RecordingLogger,
  effort: "none" | "low",
  agentModel: AgentModel<OpenAiContinuation> = model(logger, { effort }),
) {
  return createAgentRunner({
    model: agentModel,
    registry: application.tools,
    // The test's own executor, so its tool events reach the recording logger the gates count.
    executeTool: createToolExecutor({
      registry: application.tools,
      clock: systemClock,
      logger,
      maxResultBytes: application.config.maxToolResultBytes,
    }),
    ids: systemIdGenerator,
    clock: systemClock,
    logger,
    limits: application.config.agent,
  });
}

function events(logger: RecordingLogger, message: string): number {
  return logger.entries.filter((entry) => entry.message === message).length;
}

function report(gate: string, fields: Record<string, string | number | boolean>): void {
  process.stdout.write(`${JSON.stringify({ gate, model: config.openai.model, ...fields })}\n`);
}

const signal = (): AbortSignal => new AbortController().signal;

/** One fixed prompt per tool that should make the model call exactly that tool. */
const TOOL_PROMPTS = [
  ["get_current_time", "Call get_current_time for the time zone Europe/Berlin."],
  ["calculate", "Call calculate to add 2 and 3."],
  ["create_note", "Call create_note to save the note text: live verification note."],
  ["read_note", "Call read_note for the note id 0123456789abcdef0123456789abcdef."],
] as const;

const jsonObjectSchema = z.record(z.string(), z.json());

/** Schema shapes the registry does not use yet but the projection must support in strict mode. */
function syntheticTool(name: string, inputSchema: z.ZodObject): ToolDefinition {
  return defineTool({
    name,
    description: `Live schema check: ${name}. Call it when asked.`,
    risk: "read",
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: 1_000,
    inputSchema,
    outputSchema: z.strictObject({}),
    failures: {},
    execute: async () => ok({}),
  });
}

const SYNTHETIC_TOOLS = [
  [syntheticTool("live_empty_input", z.strictObject({})), "Call live_empty_input now."],
  [
    syntheticTool(
      "live_string_bounds",
      z.strictObject({
        code: z
          .string()
          .min(3)
          .max(8)
          .regex(/^[A-Z]+$/)
          .describe("3 to 8 uppercase letters."),
      }),
    ),
    "Call live_string_bounds with the code ABCDE.",
  ],
  [
    syntheticTool(
      "live_nested",
      z.strictObject({
        point: z
          .strictObject({ x: z.number().describe("X."), y: z.number().describe("Y.") })
          .describe("A point."),
      }),
    ),
    "Call live_nested with the point x = 1 and y = 2.",
  ],
] as const;

describe("G1 (hard): strict synthetic schemas (empty object, string bounds, nesting)", () => {
  it.each(SYNTHETIC_TOOLS)(
    "accepts the strict schema of $name and returns conforming arguments",
    async (tool, prompt) => {
      const [modelTool] = createModelTools([tool]);

      if (modelTool === undefined) {
        throw new Error(`No projection for ${tool.name}.`);
      }

      const result = await model(createRecordingLogger()).respond(
        {
          instructions: AGENT_INSTRUCTIONS,
          tools: [modelTool],
          transcript: [{ kind: "user_text", text: prompt }],
        },
        signal(),
      );

      const call = result.ok ? result.value.toolCalls.at(0) : undefined;
      const conforms = tool.inputSchema.safeParse(call?.arguments).success;

      report("G1", {
        tool: tool.name,
        outcome: result.ok ? "ok" : result.error.code,
        called: call?.name === tool.name,
        conforms,
      });
      expect(result.ok).toBe(true);
      expect(call?.name).toBe(tool.name);
      expect(conforms).toBe(true);
    },
  );
});

describe("G1 (hard): strict projected tool schemas", () => {
  it.each(TOOL_PROMPTS)(
    "accepts the strict schema of %s and returns conforming arguments",
    async (name, prompt) => {
      const logger = createRecordingLogger();
      const tool = createModelTools(application.tools.tools).find((each) => each.name === name);

      if (tool === undefined) {
        throw new Error(`No tool or prompt for ${name}.`);
      }

      const result = await model(logger).respond(
        {
          instructions: AGENT_INSTRUCTIONS,
          tools: [tool],
          transcript: [{ kind: "user_text", text: prompt }],
        },
        signal(),
      );

      report("G1", { tool: name, outcome: result.ok ? "ok" : result.error.code });
      expect(result.ok).toBe(true);

      const call = result.ok
        ? result.value.toolCalls.find((each) => each.name === name)
        : undefined;

      const canonical = application.tools.find(name);
      const args = jsonObjectSchema.parse(call?.arguments);

      const executed =
        canonical?.idempotency === "key" ? withHostIdempotencyKey("live-turn", name, args) : args;

      expect(canonical?.inputSchema.safeParse(executed).success).toBe(true);
    },
  );
});

/** Metadata about provider continuations: counts only, never their content. */
interface ReasoningStats {
  steps: number;
  reasoningItems: number;
  reasoningItemsWithEncryptedContent: number;
  /** Reasoning items sent back in later requests as part of earlier steps' continuations. */
  replayedReasoningItems: number;
}

function isReasoning(item: ResponseInputItem): item is ResponseReasoningItem {
  return item.type === "reasoning";
}

/** Wraps the real adapter to count reasoning items going out and coming back. */
function observed(
  inner: AgentModel<OpenAiContinuation>,
  stats: ReasoningStats,
): AgentModel<OpenAiContinuation> {
  return {
    respond: async (request, abortSignal) => {
      stats.replayedReasoningItems += request.transcript
        .flatMap((item) => (item.kind === "model_step" ? item.continuation : []))
        .filter(isReasoning).length;

      const result = await inner.respond(request, abortSignal);

      if (result.ok) {
        const reasoning = result.value.continuation.filter(isReasoning);

        stats.steps += 1;
        stats.reasoningItems += reasoning.length;
        stats.reasoningItemsWithEncryptedContent += reasoning.filter(
          (item) => (item.encrypted_content ?? "") !== "",
        ).length;
      }

      return result;
    },
  };
}

interface UsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function usageTotals(logger: RecordingLogger): UsageTotals {
  const completed = logger.entries.filter((entry) => entry.message === "model.request_completed");

  return {
    inputTokens: completed.reduce(
      (sum, { fields: { inputTokens } }) => sum + Number(inputTokens ?? 0),
      0,
    ),
    outputTokens: completed.reduce(
      (sum, { fields: { outputTokens } }) => sum + Number(outputTokens ?? 0),
      0,
    ),
  };
}

describe.each(["none", "low"] as const)(
  "G2/G3 (hard): stateless continuation, effort %s",
  (effort) => {
    it("completes a turn with two dependent tool rounds, replaying every continuation", async () => {
      const logger = createRecordingLogger();

      const stats: ReasoningStats = {
        steps: 0,
        reasoningItems: 0,
        reasoningItemsWithEncryptedContent: 0,
        replayedReasoningItems: 0,
      };

      const started = performance.now();

      const result = await runner(
        logger,
        effort,
        observed(model(logger, { effort }), stats),
      )(
        "Use the calculate tool to multiply 6 by 7. Then use the calculate tool again to add 100 " +
          "to that result. Answer with the final number only.",
        signal(),
      );

      report("G2/G3", {
        effort,
        outcome: result.ok ? "ok" : result.error.code,
        modelRequests: events(logger, "model.request_completed"),
        failedRequests: events(logger, "model.request_failed"),
        toolCalls: events(logger, "tool.completed"),
        ...stats,
        ...usageTotals(logger),
        latencyMs: Math.round(performance.now() - started),
      });
      expect(result.ok).toBe(true);
      expect(events(logger, "model.request_completed")).toBeGreaterThanOrEqual(3);
      expect(events(logger, "model.request_failed")).toBe(0);
      // Every reasoning item came back with encrypted content and was sent back in later requests.
      expect(stats.reasoningItemsWithEncryptedContent).toBe(stats.reasoningItems);
      // At low effort the turn must actually exercise encrypted-reasoning replay.
      expect(effort === "none" || stats.reasoningItems > 0).toBe(true);
      expect(effort === "none" || stats.replayedReasoningItems > 0).toBe(true);
    });
  },
);

describe("G4 (observational): parallel_tool_calls accepted", () => {
  it("accepts a request that allows several calls in one response", async () => {
    const logger = createRecordingLogger();

    const result = await runner(logger, config.openai.reasoningEffort)(
      "Use the calculate tool to add 1 and 2, and separately to multiply 3 and 4. Answer briefly.",
      signal(),
    );

    const accepted = logger.entries.filter((entry) => entry.message === "turn.tool_calls_accepted");

    const largestBatch = Math.max(
      0,
      ...accepted.map(({ fields: { toolCallIds } }) =>
        Array.isArray(toolCallIds) ? toolCallIds.length : 0,
      ),
    );

    report("G4", { outcome: result.ok ? "ok" : result.error.code, largestBatch });
    expect(result.ok).toBe(true);
  });
});

/** One G5 prompt's safe metadata. */
interface PromptEvaluation {
  readonly completed: number;
  readonly choseExpected: number;
  readonly unnecessaryCalls: number;
  readonly modelRequests: number;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

async function evaluatePrompt(
  effort: "none" | "low",
  index: number,
  [prompt, expectedTool]: readonly [string, string | null],
): Promise<PromptEvaluation> {
  const logger = createRecordingLogger();
  const started = performance.now();
  const result = await runner(logger, effort)(prompt, signal());
  const latencyMs = Math.round(performance.now() - started);

  const tools = logger.entries
    .filter((entry) => entry.message === "tool.completed" || entry.message === "tool.failed")
    .map(({ fields: { toolName } }) => String(toolName));

  const choseExpected = expectedTool === null ? tools.length === 0 : tools.includes(expectedTool);

  const evaluation: PromptEvaluation = {
    completed: result.ok ? 1 : 0,
    choseExpected: choseExpected ? 1 : 0,
    unnecessaryCalls: tools.filter((tool) => tool !== expectedTool).length,
    modelRequests:
      events(logger, "model.request_completed") + events(logger, "model.request_failed"),
    latencyMs,
    ...usageTotals(logger),
  };

  report("G5", {
    effort,
    prompt: index,
    outcome: result.ok ? "ok" : result.error.code,
    expectedTool: expectedTool ?? "none",
    calledTools: tools.join(",") || "none",
    ...evaluation,
  });

  return evaluation;
}

describe("G5 (evaluation): reasoning effort none vs low", () => {
  /** Fixed, non-sensitive prompts with the one tool a good answer needs (`null`: no tool). */
  const PROMPTS: readonly (readonly [string, string | null])[] = [
    ["What is 17 times 23?", "calculate"],
    ["Divide 144 by 12 and then add 5 to the result.", "calculate"],
    ["What time is it in Tokyo right now?", "get_current_time"],
    ["Please remember that the dentist appointment is on Friday.", "create_note"],
    ["What does the note with id 0123456789abcdef0123456789abcdef say?", "read_note"],
    ["Say hello in one short sentence.", null],
    ["What is the capital of France?", null],
  ];

  it.each(["none", "low"] as const)(
    "records completion, tool choice, requests, latency, and tokens with effort %s",
    async (effort) => {
      const evaluations: PromptEvaluation[] = [];

      for (const [index, entry] of PROMPTS.entries()) {
        evaluations.push(await evaluatePrompt(effort, index, entry));
      }

      const sum = (field: keyof PromptEvaluation): number =>
        evaluations.reduce((total, evaluation) => total + evaluation[field], 0);

      report("G5-summary", {
        effort,
        prompts: PROMPTS.length,
        completed: sum("completed"),
        choseExpected: sum("choseExpected"),
        unnecessaryCalls: sum("unnecessaryCalls"),
        modelRequests: sum("modelRequests"),
        latencyMs: sum("latencyMs"),
        inputTokens: sum("inputTokens"),
        outputTokens: sum("outputTokens"),
      });

      // An evaluation, not a quality assertion: every prompt must have produced a recorded outcome.
      expect(evaluations).toHaveLength(PROMPTS.length);
    },
  );
});

describe("G6 (observational): provider errors map to supported classifications", () => {
  it("maps an invalid API key to rejected", async () => {
    const result = await model(createRecordingLogger(), {
      apiKey: "sk-invalid-live-check",
    }).respond(
      { instructions: "Answer.", tools: [], transcript: [{ kind: "user_text", text: "Hi." }] },
      signal(),
    );

    report("G6", { case: "invalid key", outcome: result.ok ? "ok" : result.error.code });
    expect(result.ok ? "ok" : result.error.code).toBe("rejected");
  });

  it("maps an unknown model to rejected", async () => {
    const result = await model(createRecordingLogger(), {
      model: "gpt-nonexistent-live-check",
    }).respond(
      { instructions: "Answer.", tools: [], transcript: [{ kind: "user_text", text: "Hi." }] },
      signal(),
    );

    report("G6", { case: "unknown model", outcome: result.ok ? "ok" : result.error.code });
    expect(result.ok ? "ok" : result.error.code).toBe("rejected");
  });
});

describe("G8 (smoke): the built CLI prints only the answer", () => {
  it("writes one answer line to stdout and exits 0", () => {
    const run = spawnSync(
      process.execPath,
      [
        join("dist", "entrypoints", "voice-agent.js"),
        "ask",
        "--text",
        "What is 2 + 3? Use the calculate tool.",
      ],
      // Inherits the environment: the key reaches the CLI the way a user's shell passes it.
      { encoding: "utf8" },
    );

    report("G8", { exitCode: run.status ?? -1, stdoutLines: run.stdout.split("\n").length - 1 });
    expect(run.status).toBe(0);
    // Logs may go to stderr; stdout carries the answer line only.
    expect(run.stdout).toMatch(/^[^\n]+\n$/);
  });
});
