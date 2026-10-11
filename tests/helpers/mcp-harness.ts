import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type Server } from "@modelcontextprotocol/server";
import { createMcpServer } from "../../src/adapters/mcp/create-mcp-server.js";
import { createToolExecutor, type ToolExecutor } from "../../src/app/tools/tool-executor.js";
import { createToolRegistry } from "../../src/app/tools/tool-registry.js";
import type { Clock } from "../../src/ports/clock.js";
import type { IdGenerator } from "../../src/ports/id-generator.js";
import type { Logger } from "../../src/ports/logger.js";
import type { ToolDefinition } from "../../src/tools/tool-definition.js";
import { createFakeClock } from "./fake-clock.js";
import { createFakeIdGenerator } from "./fake-id-generator.js";
import { createRecordingLogger, type RecordingLogger } from "./recording-logger.js";

export interface McpHarnessOptions {
  readonly tools: readonly ToolDefinition[];
  readonly maxInFlightCalls?: number;
  readonly maxResultBytes?: number;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
  /** Replaces the real executor, for tests of what the server hands it. */
  readonly executeTool?: ToolExecutor;
  /** Wraps the real executor, to hold a call before or after it while the executor itself runs. */
  readonly wrapExecutor?: (inner: ToolExecutor) => ToolExecutor;
}

export interface McpHarness {
  /** The official client, connected to the server over an in-memory transport. */
  readonly client: Client;
  readonly server: Server;
  readonly logger: RecordingLogger;
  close(): Promise<void>;
}

/** The server as production composes it, minus stdio: real registry, executor, and descriptors. */
export function buildMcpServer(
  options: McpHarnessOptions,
  logger: Logger = createRecordingLogger(),
): Server {
  const registry = createToolRegistry(options.tools);

  const real = createToolExecutor({
    registry,
    clock: options.clock ?? createFakeClock(),
    logger,
    maxResultBytes: options.maxResultBytes ?? 16_384,
  });

  const executeTool = options.executeTool ?? options.wrapExecutor?.(real) ?? real;

  return createMcpServer({
    serverInfo: { name: "voice-agent-mcp-test", version: "0.0.0" },
    tools: registry,
    executeTool,
    ids: options.ids ?? createFakeIdGenerator("id"),
    maxInFlightCalls: options.maxInFlightCalls ?? 16,
  });
}

export interface McpConnection {
  readonly client: Client;
  close(): Promise<void>;
}

/** Connects the official MCP client to a built server; the transport is in-process, so no I/O. */
export async function connectClient(server: Server): Promise<McpConnection> {
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    close: async (): Promise<void> => {
      await client.close();
      await server.close();
    },
  };
}

/** Builds the server with a recording logger and connects the official client to it. */
export async function connectMcp(options: McpHarnessOptions): Promise<McpHarness> {
  const logger = createRecordingLogger();
  const server = buildMcpServer(options, logger);
  const connection = await connectClient(server);

  return { ...connection, server, logger };
}
