import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import { CLI_ENTRY, DIST_CLI_ENTRY, type ExitInfo, runtimeArguments } from "./mcp-child.js";
import { modernRequest } from "./mcp-wire.js";

/** What every answer to a numbered request looks like; anything else on stdout is stray. */
const jsonRpcResponse = z.looseObject({ jsonrpc: z.literal("2.0"), id: z.number() });

/** How long the writer waits for the server to take more input before calling it stalled. */
const STALL_WAIT_MS = 2_500;

export interface UnreadServer {
  readonly pid: number | undefined;
  /** Requests written so far, including one the server has not taken yet. */
  issued(): number;
  /** Sends `tools/list` requests until the server stops taking input, or `limit` were sent. */
  floodUntilStalled(limit: number): Promise<{ readonly stalled: boolean }>;
  /** Sends exactly `count` more requests, waiting for the server whenever it pushes back. */
  send(count: number): Promise<void>;
  /** Starts reading stdout, as a client that caught up; `readEveryMs` throttles it into a slow reader. */
  startReading(readEveryMs?: number): void;
  /** Ids answered so far, and any stdout line that is not a JSON-RPC message. */
  answeredIds(): readonly number[];
  strayLines(): readonly string[];
  stderrText(): string;
  /** Resident memory in MB (Linux only; `undefined` elsewhere). */
  rssMb(): number | undefined;
  endStdin(): void;
  kill(signal: NodeJS.Signals): void;
  exited: Promise<ExitInfo>;
}

/** Resident set size of a process in MB, where the platform exposes it cheaply. */
function residentMb(pid: number | undefined): number | undefined {
  if (pid === undefined || process.platform !== "linux") {
    return undefined;
  }

  const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));

  return match?.[1] === undefined ? undefined : Number(match[1]) / 1_024;
}

/**
 * The server in a child process whose stdout nobody reads until the test says so: a client that
 * sends requests and stops reading answers. The child is always killed and awaited, and its data
 * directory removed, however the body ends.
 */
export async function withUnreadServer<T>(
  compiled: boolean,
  body: (server: UnreadServer) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "mcp-backpressure-"));

  const child = spawn(
    process.execPath,
    [...runtimeArguments(compiled), compiled ? DIST_CLI_ENTRY : CLI_ENTRY, "mcp"],
    {
      env: { ...getDefaultEnvironment(), DATA_DIR: dataDir, LOG_LEVEL: "silent" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let alive = true;
  let issued = 0;
  let pending = "";
  let stderr = "";
  const answered: number[] = [];
  const strays: string[] = [];
  let reader: NodeJS.Timeout | undefined;

  const exited = new Promise<ExitInfo>((resolve) => {
    child.on("exit", (code, signal) => {
      alive = false;
      resolve({ code, signal });
    });
  });

  child.stdin.on("error", () => undefined);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.setEncoding("utf8");
  // No 'data' listener yet: the stream stays paused, so the operating system's pipe fills.
  child.stdout.pause();

  const take = (chunk: string): void => {
    pending += chunk;

    for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
      const line = pending.slice(0, end);

      pending = pending.slice(end + 1);

      try {
        const message = jsonRpcResponse.safeParse(JSON.parse(line));

        if (message.success) {
          answered.push(message.data.id);
        } else {
          strays.push(line);
        }
      } catch {
        strays.push(line);
      }
    }
  };

  const write = async (): Promise<boolean> => {
    issued += 1;

    const accepted = child.stdin.write(`${JSON.stringify(modernRequest(issued, "tools/list"))}\n`);

    if (accepted) {
      return true;
    }

    const outcome = await Promise.race([
      new Promise<"drained">((resolve) => child.stdin.once("drain", () => resolve("drained"))),
      new Promise<"stalled">((resolve) => setTimeout(() => resolve("stalled"), STALL_WAIT_MS)),
    ]);

    return outcome === "drained";
  };

  const server: UnreadServer = {
    pid: child.pid,
    issued: () => issued,
    floodUntilStalled: async (limit) => {
      while (issued < limit) {
        if (!(await write())) {
          return { stalled: true };
        }
      }

      return { stalled: false };
    },
    send: async (count) => {
      for (let index = 0; index < count; index += 1) {
        await write();
      }
    },
    startReading: (readEveryMs) => {
      child.stdout.on("data", take);

      if (readEveryMs === undefined) {
        child.stdout.resume();

        return;
      }

      // A slow reader: a short burst of reading every `readEveryMs`.
      child.stdout.pause();
      reader = setInterval(() => {
        child.stdout.resume();
        setTimeout(() => child.stdout.pause(), 2);
      }, readEveryMs);
    },
    answeredIds: () => answered,
    strayLines: () => [...strays, ...(pending === "" ? [] : [pending])],
    stderrText: () => stderr,
    rssMb: () => residentMb(child.pid),
    endStdin: () => {
      child.stdin.end();
    },
    kill: (signal) => {
      child.kill(signal);
    },
    exited,
  };

  try {
    return await body(server);
  } finally {
    clearInterval(reader);

    if (alive) {
      child.kill("SIGKILL");
    }

    await exited;
    await rm(dataDir, { recursive: true, force: true });
  }
}
