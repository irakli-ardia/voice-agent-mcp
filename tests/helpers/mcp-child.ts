import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { isJSONRPCErrorResponse, isJSONRPCResultResponse } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { JsonObject } from "../../src/domain/json-value.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

/**
 * The tsx loader by absolute URL, so a child started in any working directory (some tests choose an
 * empty one on purpose) still finds it; the bare name `tsx` is resolved from the working directory.
 */
const TSX_LOADER = pathToFileURL(
  join(REPO_ROOT, "node_modules", "tsx", "dist", "esm", "index.mjs"),
).href;

/** The shipped command: `voice-agent mcp`, run from source. */
export const CLI_ENTRY = join(REPO_ROOT, "src", "entrypoints", "voice-agent.ts");

/**
 * A test-only server: the same `runMcpStdio`, with a note store whose writes the test releases. It
 * is plain JavaScript that loads the application from `src` or `dist` (MCP_HARNESS_TREE).
 */
export const GATED_WRITE_ENTRY = join(REPO_ROOT, "tests", "helpers", "mcp-gated-write-server.mjs");

/** The compiled command (`npm run build`): plain JavaScript, run by plain `node`. */
export const DIST_CLI_ENTRY = join(REPO_ROOT, "dist", "entrypoints", "voice-agent.js");

/**
 * How node is started. Anything that loads TypeScript sources needs the `tsx` loader; the compiled
 * distribution is plain JavaScript that `node` runs as is, which the built-distribution tests rely on.
 */
export function runtimeArguments(compiled: boolean): readonly string[] {
  return compiled ? [] : ["--import", TSX_LOADER];
}

/** Longest any single wait may take before the test fails instead of hanging. */
const WAIT_LIMIT_MS = 30_000;

export interface McpChildOptions {
  readonly entry: string;
  /** True: run the entry with plain node (compiled JavaScript). False: through the tsx loader. */
  readonly compiled?: boolean;
  readonly args?: readonly string[];
  /** Working directory of the child (default: the repository root). */
  readonly cwd?: string;
  /** Added to a clean environment that never contains an OpenAI key. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface McpChild {
  readonly pid: number | undefined;
  /** Every complete stdout line, in order. */
  readonly stdoutLines: readonly string[];
  /** Stdout bytes not yet ended by a newline. */
  stdoutRemainder(): string;
  stderrText(): string;
  /** Messages the child sent over its IPC channel (the gated harness only). */
  readonly ipc: readonly JsonObject[];
  send(message: JsonObject): Promise<void>;
  sendRaw(text: string): Promise<void>;
  sendIpc(message: JsonObject): void;
  /** Lines of stdout that are not valid JSON-RPC messages: must always be empty. */
  strayStdout(): readonly string[];
  responsesTo(id: number | string): readonly JsonObject[];
  whenResponse(id: number | string): Promise<JsonObject>;
  whenIpc(type: string, index?: number): Promise<JsonObject>;
  endStdin(): void;
  exited: Promise<ExitInfo>;
  kill(signal?: NodeJS.Signals): void;
  isAlive(): boolean;
}

const jsonRpcMessage = z.looseObject({ jsonrpc: z.literal("2.0") });

/** Fails the test, instead of hanging it, if `promise` has not settled within the wait limit. */
export async function withinLimit<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${WAIT_LIMIT_MS} ms waiting for ${what}.`)),
      WAIT_LIMIT_MS,
    );
  });

  return Promise.race([promise, limit]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * The SDK's allowlist of variables safe to hand a server (PATH, HOME and the like), so the child
 * never inherits the developer's secrets, such as an OpenAI key, from the test runner.
 */
function cleanEnvironment(extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...getDefaultEnvironment(), ...extra };
}

function wrap(child: ChildProcess): McpChild {
  const lines: string[] = [];
  const ipc: JsonObject[] = [];
  const waiters: (() => void)[] = [];
  let pending = "";
  let stderr = "";
  let alive = true;

  const notify = (): void => {
    for (const waiter of [...waiters]) {
      waiter();
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    pending += chunk;

    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      lines.push(pending.slice(0, end));
      pending = pending.slice(end + 1);
    }

    notify();
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin?.on("error", () => undefined);
  child.on("message", (message) => {
    ipc.push(z.record(z.string(), z.json()).parse(message));
    notify();
  });

  const exited = new Promise<ExitInfo>((resolve) => {
    child.on("exit", (code, signal) => {
      alive = false;
      notify();
      resolve({ code, signal });
    });
  });

  const messages = (): JsonObject[] =>
    lines.flatMap((line) => {
      try {
        const parsed = jsonRpcMessage.safeParse(JSON.parse(line));

        return parsed.success ? [z.record(z.string(), z.json()).parse(parsed.data)] : [];
      } catch {
        return [];
      }
    });

  const responses = (id: number | string): JsonObject[] =>
    messages().filter(({ id: messageId, ...rest }) => {
      const message = { id: messageId, ...rest };

      return (
        messageId === id && (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message))
      );
    });

  const until = async <T>(find: () => T | undefined, what: string): Promise<T> =>
    withinLimit(
      new Promise<T>((resolve) => {
        const check = (): void => {
          const found = find();

          if (found !== undefined) {
            waiters.splice(waiters.indexOf(check), 1);
            resolve(found);
          }
        };

        waiters.push(check);
        check();
      }),
      what,
    );

  const write = async (text: string): Promise<void> =>
    new Promise((resolve) => {
      if (child.stdin === null || child.stdin.destroyed) {
        resolve();

        return;
      }

      // A write into a pipe the server has already closed fails with EPIPE/EOF, as it would for any
      // client. That is a fact about the server to assert on (exit code, missing response), not an
      // error in the test, so it does not reject.
      child.stdin.write(text, () => resolve());
    });

  return {
    pid: child.pid,
    stdoutLines: lines,
    stdoutRemainder: (): string => pending,
    stderrText: (): string => stderr,
    ipc,
    send: async (message): Promise<void> => write(`${JSON.stringify(message)}\n`),
    sendRaw: write,
    sendIpc: (message): void => {
      child.send(message);
    },
    strayStdout: (): readonly string[] => [
      ...lines.filter((line) => {
        try {
          return !jsonRpcMessage.safeParse(JSON.parse(line)).success;
        } catch {
          return true;
        }
      }),
      ...(pending === "" ? [] : [pending]),
    ],
    responsesTo: responses,
    whenResponse: async (id) => until(() => responses(id)[0], `a response to request ${id}`),
    whenIpc: async (type, index) =>
      until(
        () =>
          ipc.find(
            ({ type: kind, index: position }) =>
              kind === type && (index === undefined || position === index),
          ),
        `IPC message ${type}${index === undefined ? "" : ` #${index}`}`,
      ),
    endStdin: (): void => {
      child.stdin?.end();
    },
    exited,
    kill: (signal): void => {
      child.kill(signal);
    },
    isAlive: (): boolean => alive,
  };
}

/**
 * Runs the server in a child process and always cleans it up: whatever the test does, the process
 * is killed if still alive and its exit awaited, so none is ever left behind.
 */
export async function withMcpChild<T>(
  options: McpChildOptions,
  body: (child: McpChild) => Promise<T>,
): Promise<T> {
  const usesIpc = options.entry === GATED_WRITE_ENTRY;

  const process_ = spawn(
    process.execPath,
    [...runtimeArguments(options.compiled === true), options.entry, ...(options.args ?? [])],
    {
      cwd: options.cwd ?? REPO_ROOT,
      env: cleanEnvironment(options.env ?? {}),
      stdio: usesIpc ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
    },
  );

  const child = wrap(process_);

  try {
    return await body(child);
  } finally {
    if (child.isAlive()) {
      child.kill();
    }

    await child.exited.catch(() => undefined);
  }
}
