import type { DestinationStream } from "pino";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPinoLogger } from "../../../../src/adapters/logging/pino-logger.js";
import { createAgentRunner } from "../../../../src/app/agent/agent-runner.js";
import { createToolExecutor } from "../../../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../../../src/app/tools/tool-registry.js";
import { ok } from "../../../../src/domain/result.js";
import type { Logger } from "../../../../src/ports/logger.js";
import { defineTool, type ToolDefinition } from "../../../../src/tools/tool-definition.js";
import { createFakeAgentModel, step, toolCall } from "../../../helpers/fake-agent-model.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../../../helpers/fake-id-generator.js";
import { testConfig } from "../../../helpers/test-config.js";

const SECRET = "SECRET_SENTINEL_5d2c9e";

const SECRET_NAME = "SECRET_NAME_SENTINEL_71b0aa";

const SECRET_CAUSE = "SECRET_CAUSE_SENTINEL_e3f418";

const SECRET_STACK = "SECRET_STACK_SENTINEL_9a6c02";

const SECRET_SUBCLASS = "SECRET_SUBCLASS_SENTINEL_44d7f1";

const SECRET_PLAIN = "SECRET_PLAIN_SENTINEL_b81e57";

const ALL_SECRETS = [
  SECRET,
  SECRET_NAME,
  SECRET_CAUSE,
  SECRET_STACK,
  SECRET_SUBCLASS,
  SECRET_PLAIN,
];

const PUBLIC_ERROR = {
  ok: false,
  error: { code: "internal_error", message: "The tool failed unexpectedly." },
} as const;

interface CapturedLogger {
  readonly logger: Logger;
  text(): string;
  lines(): readonly string[];
}

/** The real pino logger writing into memory: the lines are exactly what stderr would receive. */
function capturedLogger(): CapturedLogger {
  const lines: string[] = [];

  const destination: DestinationStream = {
    write: (line: string): void => {
      lines.push(line);
    },
  };

  return {
    logger: createPinoLogger({ level: "trace", destination }),
    text: () => lines.join(""),
    lines: () => lines,
  };
}

/** Everything a handler might throw or reject with. */
type Thrown =
  | Error
  | string
  | null
  | { readonly name?: string; readonly message?: string; readonly token?: string };

/** A tool whose handler rejects with whatever `build` makes. */
function rejectingTool(build: () => Thrown): ToolDefinition {
  return defineTool({
    name: "rejecting",
    description: "Rejects.",
    risk: "read",
    requiresConfirmation: false,
    idempotency: "none",
    timeoutMs: 1_000,
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
    failures: {},
    execute: async () => Promise.reject(build()),
  });
}

function executorFor(tool: ToolDefinition, logger: Logger) {
  return createToolExecutor({
    registry: createToolRegistry([tool]),
    clock: createFakeClock(),
    logger,
    maxResultBytes: 1_024,
  });
}

function call() {
  return { id: "call-1", name: "rejecting", arguments: {} };
}

class DatabaseError extends Error {
  public constructor() {
    super(`password=${SECRET_SUBCLASS}`);
    this.name = "DatabaseError";
  }
}

class SubclassOfTypeError extends TypeError {
  public constructor() {
    super(`token=${SECRET_SUBCLASS}`);
  }
}

class SubclassWithSecretName extends Error {
  public override get name(): string {
    return `Error ${SECRET_NAME}`;
  }
}

function withName(error: Error, name: string | { readonly toString: () => string }): Error {
  Object.defineProperty(error, "name", { value: name, configurable: true });

  return error;
}

const HOSTILE = [
  ["Error with a secret message", () => new Error(`db down: ${SECRET}`), "Error"],
  ["Error with a secret custom name", () => withName(new Error("m"), SECRET_NAME), "other_error"],
  [
    "Error with a very long secret name",
    () => withName(new Error("m"), SECRET_NAME.repeat(5_000)),
    "other_error",
  ],
  [
    "Error whose name getter returns a secret",
    () =>
      Object.defineProperty(new Error("m"), "name", {
        get: () => SECRET_NAME,
      }),
    "other_error",
  ],
  [
    "Error with a non-string name",
    () => withName(new Error("m"), { toString: () => SECRET_NAME }),
    "other_error",
  ],
  [
    "Error with a secret cause",
    () => new Error("outer", { cause: new Error(`inner ${SECRET_CAUSE}`) }),
    "Error",
  ],
  [
    "Error with a secret cause that is a string",
    () => new Error("outer", { cause: SECRET_CAUSE }),
    "Error",
  ],
  [
    "Error with a secret stack",
    () => {
      const error = new Error("m");

      error.stack = `Error: m\n    at ${SECRET_STACK} (C:\\secret\\path.ts:1:1)`;

      return error;
    },
    "Error",
  ],
  ["a custom Error subclass with its own name", () => new DatabaseError(), "other_error"],
  ["a subclass of TypeError", () => new SubclassOfTypeError(), "TypeError"],
  [
    "a subclass whose name getter returns a secret",
    () => new SubclassWithSecretName(SECRET_NAME),
    "other_error",
  ],
  [
    "a thrown plain object",
    () => ({ token: SECRET_PLAIN, message: SECRET_PLAIN }),
    "non_error_thrown",
  ],
  [
    "a thrown object that imitates an Error",
    () => ({ name: "Error", message: SECRET_PLAIN }),
    "non_error_thrown",
  ],
  ["a thrown string", () => SECRET_PLAIN, "non_error_thrown"],
  ["a thrown null", () => null, "non_error_thrown"],
] as const;

describe("the executor never logs what a handler throws", () => {
  it.each(HOSTILE)(
    "%s: the log names a safe class only, and the public result is unchanged",
    async (_label, build, expectedClass) => {
      const { logger, text, lines } = capturedLogger();

      const result = await executorFor(rejectingTool(build), logger)(
        call(),
        new AbortController().signal,
      );

      expect(result).toEqual(PUBLIC_ERROR);

      const [line] = lines();

      const logged = z
        .object({ msg: z.string(), outcome: z.string(), errorClass: z.string() })
        .parse(JSON.parse(line ?? "{}"));

      expect(lines()).toHaveLength(1);
      expect(logged).toMatchObject({
        msg: "tool.failed",
        outcome: "internal_error",
        errorClass: expectedClass,
      });
      expect(text()).not.toMatch(/errorMessage|errorName|"stack"|"cause"/);
      expect(text().length).toBeLessThan(600);

      for (const secret of ALL_SECRETS) {
        expect(text()).not.toContain(secret);
      }
    },
  );

  it("keeps a handler that throws synchronously from its bound call out of the logs too", async () => {
    const { logger, text } = capturedLogger();

    const tool: ToolDefinition = {
      ...rejectingTool(() => null),
      bindArguments: () => {
        throw new Error(`bind failed ${SECRET}`);
      },
    };

    const result = await executorFor(tool, logger)(call(), new AbortController().signal);

    expect(result).toEqual(PUBLIC_ERROR);
    expect(text()).toContain("tool.failed");
    expect(text()).not.toContain(SECRET);
  });

  it("still logs the diagnostics worth keeping: tool, call id, outcome, duration, risk", async () => {
    const { logger, lines } = capturedLogger();

    await executorFor(
      rejectingTool(() => new Error(SECRET)),
      logger,
    )(call(), new AbortController().signal);

    expect(JSON.parse(lines()[0] ?? "{}")).toMatchObject({
      level: 50,
      msg: "tool.failed",
      toolCallId: "call-1",
      toolName: "rejecting",
      risk: "read",
      outcome: "internal_error",
      handlerInvoked: true,
      durationMs: 0,
      errorClass: "Error",
    });
  });

  it("passes a handler's AbortError through as its useful class", async () => {
    const { logger, text } = capturedLogger();

    const result = await executorFor(
      rejectingTool(() => new DOMException("aborted by us", "AbortError")),
      logger,
    )(call(), new AbortController().signal);

    expect(result).toEqual(PUBLIC_ERROR);
    expect(text()).toContain('"errorClass":"AbortError"');
    expect(text()).not.toContain("aborted by us");
  });
});

describe("late-settling rejected handlers", () => {
  /** A handler that ignores its signal and rejects with `build()` only once released. */
  function lateRejecting(
    release: Promise<void>,
    build: () => Thrown,
    timeoutMs: number,
  ): ToolDefinition {
    return defineTool({
      name: "rejecting",
      description: "Rejects late.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({}),
      failures: {},
      execute: async () => {
        await release;

        return Promise.reject(build());
      },
    });
  }

  it.each(HOSTILE)(
    "after a timeout, %s: the late log carries only the class",
    async (_label, build, expectedClass) => {
      const { logger, text } = capturedLogger();
      const release = Promise.withResolvers<void>();

      const result = await executorFor(lateRejecting(release.promise, build, 15), logger)(
        call(),
        new AbortController().signal,
      );

      expect(result).toMatchObject({ ok: false, error: { code: "timed_out" } });

      release.resolve();
      await vi.waitFor(() => expect(text()).toContain("tool.settled_late"));

      const lateLine = text()
        .split("\n")
        .find((line) => line.includes("tool.settled_late"));

      expect(JSON.parse(lateLine ?? "{}")).toMatchObject({
        lateOutcome: "threw",
        errorClass: expectedClass,
      });

      for (const secret of ALL_SECRETS) {
        expect(text()).not.toContain(secret);
      }
    },
  );

  it("after a cancel, a rejection carrying a secret message, name, cause and stack is not logged", async () => {
    const { logger, text } = capturedLogger();
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();

    const tool = defineTool({
      name: "rejecting",
      description: "Rejects after cancellation.",
      risk: "read",
      requiresConfirmation: false,
      idempotency: "none",
      timeoutMs: 1_000,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({}),
      failures: {},
      execute: async () => {
        started.resolve();
        await release.promise;

        const error = withName(new Error(`late ${SECRET}`, { cause: SECRET_CAUSE }), SECRET_NAME);

        error.stack = SECRET_STACK;

        return Promise.reject(error);
      },
    });

    const pending = executorFor(tool, logger)(call(), controller.signal);

    await started.promise;
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });

    release.resolve();
    await vi.waitFor(() => expect(text()).toContain("tool.settled_late"));
    expect(text()).toContain('"errorClass":"other_error"');

    for (const secret of ALL_SECRETS) {
      expect(text()).not.toContain(secret);
    }
  });
});

describe("the agent loop, which runs the same executor", () => {
  it("logs nothing a tool threw, and the model sees only the public error", async () => {
    const { logger, text } = capturedLogger();

    const tool = rejectingTool(() =>
      withName(new Error(`db down ${SECRET}`, { cause: SECRET_CAUSE }), SECRET_NAME),
    );

    const registry = createToolRegistry([tool]);

    const model = createFakeAgentModel([
      step(null, [toolCall("c1", "rejecting", {})]),
      step("The tool failed."),
    ]);

    const run = createAgentRunner({
      model,
      registry,
      executeTool: createToolExecutor({
        registry,
        clock: createFakeClock(),
        logger,
        maxResultBytes: 1_024,
      }),
      ids: createFakeIdGenerator(),
      clock: createFakeClock(),
      logger,
      limits: testConfig({ dataDir: "unused-never-written" }).agent,
    });

    const answer = await run("Call the tool.", new AbortController().signal);

    expect(answer).toEqual({ ok: true, value: "The tool failed." });

    const item = model.requests[1]?.transcript.find(
      (entry) => entry.kind === "tool_result" && entry.callId === "c1",
    );

    expect(item).toMatchObject({ kind: "tool_result", result: PUBLIC_ERROR });
    expect(JSON.stringify(model.requests)).not.toContain(SECRET);
    expect(text()).toContain("tool.failed");
    expect(text()).toContain('"errorClass":"other_error"');

    for (const secret of ALL_SECRETS) {
      expect(text()).not.toContain(secret);
    }
  });
});

describe("unchanged executor outputs", () => {
  it("returns the same public result for a thrown error as before the correction", async () => {
    const { logger } = capturedLogger();

    expect(
      await executorFor(
        defineTool({
          name: "rejecting",
          description: "Returns normally.",
          risk: "read",
          requiresConfirmation: false,
          idempotency: "none",
          timeoutMs: 1_000,
          inputSchema: z.strictObject({}),
          outputSchema: z.strictObject({ n: z.number() }),
          failures: {},
          execute: async () => ok({ n: 1 }),
        }),
        logger,
      )(call(), new AbortController().signal),
    ).toEqual({ ok: true, value: { n: 1 } });
  });
});
