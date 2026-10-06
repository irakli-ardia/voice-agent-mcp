import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createToolExecutor, type ToolExecutor } from "../../../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../../../src/app/tools/tool-registry.js";
import type { JsonObject } from "../../../../src/domain/json-value.js";
import { err, ok, type Result } from "../../../../src/domain/result.js";
import type { ToolExecutionError } from "../../../../src/domain/tool-execution-error.js";
import {
  defineTool,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
} from "../../../../src/tools/tool-definition.js";
import { createFakeClock, type FakeClock } from "../../../helpers/fake-clock.js";
import { createRecordingLogger, type RecordingLogger } from "../../../helpers/recording-logger.js";

const realSetImmediate = setImmediate;

/** Lets Node report unhandled rejections, which it does only after a real macrotask turn. */
async function realMacrotask(): Promise<void> {
  await new Promise((resolve) => realSetImmediate(resolve));
}

const TIMEOUT_MS = 100;

type EchoResult = Result<{ text: string }, "rejected">;

type EchoHandler = (input: { text: string }, context: ToolContext) => Promise<EchoResult>;

function echoTool(execute: EchoHandler): ToolDefinition {
  return defineTool({
    name: "echo",
    description: "Echoes its text.",
    risk: "read",
    requiresConfirmation: false,
    timeoutMs: TIMEOUT_MS,
    inputSchema: z.strictObject({ text: z.string().max(40) }),
    outputSchema: z.strictObject({ text: z.string() }),
    failures: { rejected: "The text was rejected." },
    execute,
  });
}

const echoBack: EchoHandler = async ({ text }) => ok({ text });

const CALL: Omit<ToolCall, "arguments"> = { id: "call-1", name: "echo" };

const VALID: ToolCall = { ...CALL, arguments: { text: "hello" } };

interface Harness {
  readonly execute: ToolExecutor;
  readonly logger: RecordingLogger;
  readonly clock: FakeClock;
}

function harness(tools: readonly ToolDefinition[], maxResultBytes = 1_000): Harness {
  const logger = createRecordingLogger();
  const clock = createFakeClock();

  return {
    execute: createToolExecutor({
      registry: createToolRegistry(tools),
      clock,
      logger,
      maxResultBytes,
    }),
    logger,
    clock,
  };
}

function codeOf(result: Result<JsonObject, ToolExecutionError>): string {
  return result.ok ? "ok" : result.error.code;
}

function idle(): AbortSignal {
  return new AbortController().signal;
}

/** A handler that never settles on its own and records the signal it was given. */
function hangingHandler(seen: AbortSignal[]): EchoHandler {
  return async (_input, context) => {
    seen.push(context.signal);

    return new Promise<EchoResult>(() => {});
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  const leakedTimers = vi.getTimerCount();
  vi.useRealTimers();

  if (leakedTimers > 0) {
    throw new Error(`The test left ${leakedTimers} timer(s) running.`);
  }
});

describe("createToolExecutor: success", () => {
  it("returns the validated output and logs one completed event without payloads", async () => {
    const { execute, logger, clock } = harness([
      echoTool(async ({ text }) => {
        clock.advance(25);

        return ok({ text: text.toUpperCase() });
      }),
    ]);

    const result = await execute({ ...CALL, arguments: { text: "sk-argument-value" } }, idle());

    expect(result).toEqual({ ok: true, value: { text: "SK-ARGUMENT-VALUE" } });
    expect(logger.entries).toEqual([
      {
        level: "info",
        message: "tool.completed",
        fields: {
          toolCallId: "call-1",
          toolName: "echo",
          risk: "read",
          outcome: "ok",
          handlerInvoked: true,
          durationMs: 25,
        },
      },
    ]);
    expect(JSON.stringify(logger.entries).toLowerCase()).not.toContain("sk-argument-value");
  });

  it("returns the parsed copy, not the object the handler built", async () => {
    const built = { text: "hello" };
    const { execute } = harness([echoTool(async () => ok(built))]);

    const result = await execute(VALID, idle());

    expect(result).toEqual({ ok: true, value: built });
    expect(result.ok && result.value).not.toBe(built);
  });

  it("runs concurrent calls independently", async () => {
    const { execute } = harness([echoTool(echoBack)]);

    const results = await Promise.all([
      execute({ ...CALL, id: "a", arguments: { text: "one" } }, idle()),
      execute({ ...CALL, id: "b", arguments: { text: "two" } }, idle()),
    ]);

    expect(results).toEqual([
      { ok: true, value: { text: "one" } },
      { ok: true, value: { text: "two" } },
    ]);
  });
});

describe("createToolExecutor: lookup", () => {
  it.each([
    ["missing_tool", "missing_tool"],
    ["constructor", "constructor"],
    ["__proto__", null],
    ["Echo", null],
    [" echo", null],
    ["x".repeat(10_000), null],
  ])("rejects the unregistered name %j without invoking a handler", async (name, loggedName) => {
    const invoked: string[] = [];

    const { execute, logger } = harness([
      echoTool(async ({ text }) => {
        invoked.push(text);

        return ok({ text });
      }),
    ]);

    const result = await execute({ ...VALID, name }, idle());

    expect(result).toEqual({
      ok: false,
      error: { code: "unknown_tool", message: "No tool with this name exists." },
    });
    expect(invoked).toEqual([]);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: "warn",
        message: "tool.failed",
        fields: expect.objectContaining({
          toolName: loggedName,
          risk: null,
          outcome: "unknown_tool",
          handlerInvoked: false,
        }),
      }),
    ]);
  });
});

describe("createToolExecutor: input validation", () => {
  it("rejects invalid arguments with a safe message and never invokes the handler", async () => {
    const invoked: string[] = [];

    const { execute, logger } = harness([
      echoTool(async ({ text }) => {
        invoked.push(text);

        return ok({ text });
      }),
    ]);

    const result = await execute(
      { ...CALL, arguments: { text: 42, sk_live_KEY: "sk-secret-value" } },
      idle(),
    );

    expect(result.ok).toBe(false);
    expect(codeOf(result)).toBe("invalid_input");
    expect(result.ok || result.error.message).toBe(
      "Invalid arguments: text: Invalid input: expected string, received number; " +
        "(root): unknown properties are not allowed.",
    );
    expect(invoked).toEqual([]);

    const everything = JSON.stringify([result, logger.entries]);
    expect(everything).not.toContain("sk_live_KEY");
    expect(everything).not.toContain("sk-secret-value");
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          outcome: "invalid_input",
          handlerInvoked: false,
          issueCount: 2,
        }),
      }),
    ]);
  });

  it("does not echo a rejected value that is too long", async () => {
    const { execute } = harness([echoTool(echoBack)]);
    const secret = `sk-${"x".repeat(60)}`;

    const result = await execute({ ...CALL, arguments: { text: secret } }, idle());

    expect(result.ok || result.error.message).toMatch(/^Invalid arguments: text: Too big/);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([null, undefined, "a string", 42, [1, 2], true])(
    "rejects non-object arguments %j at the root",
    async (args) => {
      const { execute } = harness([echoTool(echoBack)]);

      const result = await execute({ ...CALL, arguments: args }, idle());

      expect(result.ok || result.error.message).toMatch(/^Invalid arguments: \(root\): /);
    },
  );

  it("rejects prototype keys from parsed JSON without polluting prototypes", async () => {
    const { execute } = harness([echoTool(echoBack)]);
    const args: unknown = JSON.parse('{"text":"a","__proto__":{"polluted":true}}');

    const result = await execute({ ...CALL, arguments: args }, idle());

    expect(result.ok || result.error.message).toBe(
      "Invalid arguments: (root): unknown properties are not allowed.",
    );
    expect(Object.getOwnPropertyNames(Object.prototype)).not.toContain("polluted");
  });

  it("reports at most ten issues and counts the rest", async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`field_${index}`, z.number()]),
    );

    const wide = defineTool({
      name: "wide",
      description: "Takes twelve numbers.",
      risk: "read",
      requiresConfirmation: false,
      timeoutMs: TIMEOUT_MS,
      inputSchema: z.strictObject(fields),
      outputSchema: z.strictObject({}),
      failures: {},
      execute: async () => ok({}),
    });

    const { execute } = harness([wide]);

    const result = await execute({ id: "call-1", name: "wide", arguments: {} }, idle());
    const message = result.ok ? "" : result.error.message;

    expect(message.split("; ")).toHaveLength(11);
    expect(message).toMatch(/; and 2 more\.$/);
  });
});

describe("createToolExecutor: policy", () => {
  const destructive = defineTool({
    name: "wipe",
    description: "Deletes everything.",
    risk: "destructive",
    requiresConfirmation: true,
    timeoutMs: TIMEOUT_MS,
    inputSchema: z.strictObject({ text: z.string().max(40) }),
    outputSchema: z.strictObject({}),
    failures: {},
    execute: async () => {
      throw new Error("must never run");
    },
  });

  it.each([
    ["a destructive tool", destructive],
    [
      "a write tool that requires confirmation",
      { ...echoTool(echoBack), requiresConfirmation: true },
    ],
  ])("fails closed for %s", async (_label, tool) => {
    const { execute, logger } = harness([tool]);

    const result = await execute({ ...VALID, name: tool.name }, idle());

    expect(result).toEqual({
      ok: false,
      error: {
        code: "confirmation_required",
        message: "This tool requires confirmation from the user, which was not given.",
      },
    });
    expect(logger.entries).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ handlerInvoked: false }) }),
    ]);
  });

  it("validates input before applying the policy", async () => {
    const { execute } = harness([destructive]);

    const result = await execute({ ...CALL, name: "wipe", arguments: {} }, idle());

    expect(codeOf(result)).toBe("invalid_input");
  });
});

describe("createToolExecutor: expected failures", () => {
  it("returns the declared reason's static message and logs only the reason", async () => {
    const { execute, logger } = harness([echoTool(async () => err("rejected"))]);

    const result = await execute(VALID, idle());

    expect(result).toEqual({
      ok: false,
      error: { code: "execution_failed", message: "The text was rejected." },
    });
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({
          outcome: "execution_failed",
          failureReason: "rejected",
          handlerInvoked: true,
        }),
      }),
    ]);
  });
});

describe("createToolExecutor: unexpected failures", () => {
  it("hides a thrown error's message from the caller and logs it", async () => {
    const { execute, logger } = harness([
      echoTool(async () => {
        throw new TypeError("connection to db failed: password=sk-db-secret");
      }),
    ]);

    const result = await execute(VALID, idle());

    expect(result).toEqual({
      ok: false,
      error: { code: "internal_error", message: "The tool failed unexpectedly." },
    });
    expect(JSON.stringify(result)).not.toContain("sk-db-secret");
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: "error",
        message: "tool.failed",
        fields: expect.objectContaining({
          outcome: "internal_error",
          handlerInvoked: true,
          errorName: "TypeError",
          errorMessage: "connection to db failed: password=sk-db-secret",
        }),
      }),
    ]);
  });

  it("never logs a thrown value that is not an Error", async () => {
    const { execute, logger } = harness([
      echoTool(async () => Promise.reject({ token: "sk-raw-value" })),
    ]);

    const result = await execute(VALID, idle());

    expect(codeOf(result)).toBe("internal_error");
    expect(JSON.stringify(logger.entries)).not.toContain("sk-raw-value");
    expect(logger.entries).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ errorName: "non_error_thrown" }),
      }),
    ]);
  });

  it.each([
    [
      "a non-string message",
      Object.defineProperty(new Error("x"), "message", { value: 42 }),
      { errorName: "Error", errorMessage: "42" },
    ],
    [
      "a message getter that throws",
      Object.defineProperty(new Error("x"), "message", {
        get: () => {
          throw new Error("getter bug");
        },
      }),
      { errorName: "unreadable_error" },
    ],
  ])("never throws itself when a thrown Error has %s", async (_label, thrown, logged) => {
    const tool: ToolDefinition = {
      ...echoTool(echoBack),
      bindArguments: () => {
        throw thrown;
      },
    };

    const { execute, logger } = harness([tool]);

    const result = await execute(VALID, idle());

    expect(codeOf(result)).toBe("internal_error");
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: "error",
        message: "tool.failed",
        fields: expect.objectContaining({ handlerInvoked: false, ...logged }),
      }),
    ]);
  });

  it("maps a handler that throws synchronously", async () => {
    const tool: ToolDefinition = {
      ...echoTool(echoBack),
      bindArguments: () =>
        ok(() => {
          throw new Error("sync failure");
        }),
    };

    const { execute, logger } = harness([tool]);

    const result = await execute(VALID, idle());

    expect(codeOf(result)).toBe("internal_error");
    expect(logger.entries).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ handlerInvoked: true }) }),
    ]);
  });

  it("maps an input schema that throws, before any handler runs", async () => {
    const throwing = defineTool({
      name: "throwing_input",
      description: "Has a buggy refinement.",
      risk: "read",
      requiresConfirmation: false,
      timeoutMs: TIMEOUT_MS,
      inputSchema: z.strictObject({
        text: z.string().refine(() => {
          throw new Error("refinement bug");
        }),
      }),
      outputSchema: z.strictObject({}),
      failures: {},
      execute: async () => ok({}),
    });

    const { execute, logger } = harness([throwing]);

    const result = await execute({ ...VALID, name: "throwing_input" }, idle());

    expect(codeOf(result)).toBe("internal_error");
    expect(logger.entries).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ handlerInvoked: false }) }),
    ]);
  });

  it("maps an output schema that throws", async () => {
    const throwing = defineTool({
      name: "throwing_output",
      description: "Has a buggy output refinement.",
      risk: "read",
      requiresConfirmation: false,
      timeoutMs: TIMEOUT_MS,
      inputSchema: z.strictObject({}),
      outputSchema: z.strictObject({
        text: z.string().refine(() => {
          throw new Error("refinement bug");
        }),
      }),
      failures: {},
      execute: async () => ok({ text: "x" }),
    });

    const { execute } = harness([throwing]);

    const result = await execute({ ...CALL, name: "throwing_output", arguments: {} }, idle());

    expect(codeOf(result)).toBe("internal_error");
  });
});

describe("createToolExecutor: output validation", () => {
  it.each([
    ["an extra key", { text: "fine", internal_path: "sk-leaked-detail" }, "", "unrecognized_keys"],
    ["a wrong type", { text: 5 }, "text", "invalid_type"],
  ])("withholds output with %s", async (_label, output, path, code) => {
    const tool: ToolDefinition = {
      ...echoTool(echoBack),
      bindArguments: () => ok(async () => ok(output)),
    };

    const { execute, logger } = harness([tool]);

    const result = await execute(VALID, idle());

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_output", message: "The tool produced an invalid result." },
    });
    expect(JSON.stringify([result, logger.entries])).not.toContain("sk-leaked-detail");
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: "error",
        fields: expect.objectContaining({
          outcome: "invalid_output",
          handlerInvoked: true,
          issues: [{ path, code }],
        }),
      }),
    ]);
  });
});

describe("createToolExecutor: result size cap", () => {
  // {"text":"éé"} is 15 UTF-8 bytes (13 characters): each é takes two.
  const output = { text: "éé" };

  it("returns a result exactly at the cap", async () => {
    const { execute } = harness([echoTool(async () => ok(output))], 15);

    expect(await execute(VALID, idle())).toEqual({ ok: true, value: output });
  });

  it("withholds a result one byte over the cap, counting UTF-8 bytes", async () => {
    const { execute, logger } = harness([echoTool(async () => ok(output))], 14);

    const result = await execute(VALID, idle());

    expect(result).toEqual({
      ok: false,
      error: { code: "output_too_large", message: "The tool result is too large to return." },
    });
    expect(logger.entries).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ resultBytes: 15 }) }),
    ]);
  });
});

describe("createToolExecutor: deadline", () => {
  it("does not time out before the deadline", async () => {
    const { execute } = harness([
      echoTool(async ({ text }) => {
        await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS - 1));

        return ok({ text });
      }),
    ]);

    const pending = execute(VALID, idle());
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);

    expect(await pending).toEqual({ ok: true, value: { text: "hello" } });
  });

  it("aborts the handler's signal and reports timed_out with an unknown outcome", async () => {
    const seen: AbortSignal[] = [];
    const { execute, logger } = harness([echoTool(hangingHandler(seen))]);

    const pending = execute(VALID, idle());
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(await pending).toEqual({
      ok: false,
      error: {
        code: "timed_out",
        message: "The tool did not finish within its time limit; its outcome is unknown.",
      },
    });
    expect(seen.map((signal) => signal.aborted)).toEqual([true]);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: expect.objectContaining({ outcome: "timed_out", handlerInvoked: true }),
      }),
    ]);
  });

  it("does not stop a handler that ignores its signal: its side effect still happens later", async () => {
    const effects: string[] = [];

    const { execute } = harness([
      echoTool(async ({ text }) => {
        await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 5));
        effects.push(`wrote ${text}`);

        return ok({ text });
      }),
    ]);

    const pending = execute(VALID, idle());
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS);

    expect(codeOf(await pending)).toBe("timed_out");
    expect(effects).toEqual([]);

    await vi.advanceTimersByTimeAsync(TIMEOUT_MS * 4);

    expect(effects).toEqual(["wrote hello"]);
  });

  it("keeps a handler that rejects after the deadline from becoming an unhandled rejection", async () => {
    const unhandled: string[] = [];

    const onUnhandled = (): void => {
      unhandled.push("unhandled rejection");
    };

    process.on("unhandledRejection", onUnhandled);

    try {
      const { execute, logger } = harness([
        echoTool(async () => {
          await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS * 2));

          throw new Error("late failure");
        }),
      ]);

      const pending = execute(VALID, idle());
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      const result = await pending;
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS);
      await realMacrotask();

      expect(codeOf(result)).toBe("timed_out");
      expect(unhandled).toEqual([]);
      expect(logger.entries).toHaveLength(1);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("createToolExecutor: cancellation", () => {
  it("never invokes the handler when the caller has already cancelled", async () => {
    const seen: AbortSignal[] = [];
    const { execute, logger } = harness([echoTool(hangingHandler(seen))]);

    const result = await execute(VALID, AbortSignal.abort());

    expect(result).toEqual({
      ok: false,
      error: { code: "cancelled", message: "The tool call was cancelled; its outcome is unknown." },
    });
    expect(seen).toEqual([]);
    expect(logger.entries).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ handlerInvoked: false }) }),
    ]);
  });

  it("stops waiting and aborts the handler's signal when the caller cancels mid-flight", async () => {
    const seen: AbortSignal[] = [];
    const caller = new AbortController();
    const { execute, logger } = harness([echoTool(hangingHandler(seen))]);

    const pending = execute(VALID, caller.signal);
    caller.abort();

    expect(codeOf(await pending)).toBe("cancelled");
    expect(seen.map((signal) => signal.aborted)).toEqual([true]);
    expect(logger.entries).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ outcome: "cancelled", handlerInvoked: true }),
      }),
    ]);
  });

  it("stops waiting when the caller cancels after the pre-start check but before waiting begins", async () => {
    const seen: AbortSignal[] = [];
    const caller = new AbortController();
    let armed = false;

    // The deadline is read between the pre-start check and the abort listener; cancel there.
    const tool: ToolDefinition = {
      ...echoTool(hangingHandler(seen)),
      get timeoutMs() {
        if (armed) {
          caller.abort();
        }

        return TIMEOUT_MS;
      },
    };

    const { execute } = harness([tool]);
    armed = true;
    let settled = false;

    const pending = execute(VALID, caller.signal).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    expect(codeOf(await pending)).toBe("cancelled");
    expect(seen.map((signal) => signal.aborted)).toEqual([true]);
  });
});

describe("createToolExecutor: precedence when waiting ends", () => {
  it("reports cancelled when the deadline fires and then the caller cancels in the same turn", async () => {
    const caller = new AbortController();
    const { execute } = harness([echoTool(hangingHandler([]))]);

    const pending = execute(VALID, caller.signal);
    vi.advanceTimersByTime(TIMEOUT_MS);
    caller.abort();

    expect(codeOf(await pending)).toBe("cancelled");
  });

  it("reports cancelled when the caller cancels and then the deadline fires in the same turn", async () => {
    const caller = new AbortController();
    const { execute } = harness([echoTool(hangingHandler([]))]);

    const pending = execute(VALID, caller.signal);
    caller.abort();
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(codeOf(await pending)).toBe("cancelled");
  });

  it("reports timed_out when the handler settles in the same turn as the deadline", async () => {
    const settle = Promise.withResolvers<EchoResult>();
    const { execute } = harness([echoTool(async () => settle.promise)]);

    const pending = execute(VALID, idle());
    settle.resolve(ok({ text: "done" }));
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(codeOf(await pending)).toBe("timed_out");
  });

  it("reports timed_out when the handler rejects in the same turn as the deadline", async () => {
    const settle = Promise.withResolvers<EchoResult>();
    const { execute } = harness([echoTool(async () => settle.promise)]);

    const pending = execute(VALID, idle());
    settle.reject(new Error("failed at the last moment"));
    vi.advanceTimersByTime(TIMEOUT_MS);

    expect(codeOf(await pending)).toBe("timed_out");
  });

  it("reports cancelled when the handler settles in the same turn as the caller cancels", async () => {
    const settle = Promise.withResolvers<EchoResult>();
    const caller = new AbortController();
    const { execute } = harness([echoTool(async () => settle.promise)]);

    const pending = execute(VALID, caller.signal);
    settle.resolve(ok({ text: "done" }));
    caller.abort();

    expect(codeOf(await pending)).toBe("cancelled");
  });

  it.each([
    ["an Error", new Error("sk-reason-secret")],
    ["a string", "sk-reason-secret"],
    ["an object", { secret: "sk-reason-secret" }],
    ["undefined", undefined],
  ])("ignores the abort reason when it is %s", async (_label, reason) => {
    const caller = new AbortController();
    const { execute, logger } = harness([echoTool(hangingHandler([]))]);

    const pending = execute(VALID, caller.signal);
    caller.abort(reason);
    const result = await pending;

    expect(result).toEqual({
      ok: false,
      error: { code: "cancelled", message: "The tool call was cancelled; its outcome is unknown." },
    });
    expect(JSON.stringify(logger.entries)).not.toContain("sk-reason-secret");
  });
});
