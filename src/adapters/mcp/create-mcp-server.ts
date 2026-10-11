import {
  type CallToolResult,
  type Implementation,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import type { ToolExecutor } from "../../app/tools/tool-executor.js";
import type { ToolRegistry } from "../../app/tools/tool-registry.js";
import { err } from "../../domain/result.js";
import type { IdGenerator } from "../../ports/id-generator.js";
import { mapToolResult } from "./mcp-result-mapper.js";
import { createMcpToolDescriptors } from "./mcp-tool-descriptors.js";

export interface McpServerDependencies {
  readonly serverInfo: Implementation;
  /** The canonical registry: the only source of the tools this server lists. */
  readonly tools: ToolRegistry;
  /** The canonical executor: the only way this server runs a tool. */
  readonly executeTool: ToolExecutor;
  readonly ids: IdGenerator;
  /** Concurrent `tools/call` requests being executed; further ones are refused. */
  readonly maxInFlightCalls: number;
}

const SERVER_BUSY = {
  code: "server_busy",
  message: "Too many tool calls are in flight; retry later.",
};

/** What any failure inside the adapter becomes. The SDK would otherwise send a thrown message. */
function internalError(): ProtocolError {
  return new ProtocolError(ProtocolErrorCode.InternalError, "Internal error");
}

/**
 * The MCP server for the canonical tools, on the SDK's low-level `Server`: `tools/list` from the
 * registry's descriptors, `tools/call` through the canonical executor. It advertises only the
 * `tools` capability and owns no transport.
 *
 * Calls run concurrently. At most `maxInFlightCalls` are executing at once; the next one is
 * refused with `server_busy` before the executor (and so any handler) is reached, and a slot is
 * released whenever the executor returns. That bounds concurrency, not request rate. A handler
 * that outlives a `cancelled` or `timed_out` result no longer holds a slot, so side effects may
 * still be running beyond the limit.
 *
 * The SDK sends a thrown error's own message to the client, so the call handler throws only
 * static `ProtocolError`s: the unknown-tool error from the mapper, or "Internal error".
 */
export function createMcpServer(dependencies: McpServerDependencies): Server {
  const { executeTool, ids, maxInFlightCalls } = dependencies;
  const descriptors = createMcpToolDescriptors(dependencies.tools.tools);
  const outputSchemas = new Map(descriptors.map((tool) => [tool.name, tool.outputSchema]));
  const server = new Server(dependencies.serverInfo, { capabilities: { tools: {} } });
  let inFlight = 0;

  server.setRequestHandler("tools/list", () => ({ tools: [...descriptors] }));

  server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
    // Check and increment run in one synchronous step, so concurrent requests cannot oversubscribe.
    if (inFlight >= maxInFlightCalls) {
      return mapToolResult(err(SERVER_BUSY));
    }

    inFlight += 1;

    try {
      const outcome = await executeTool(
        {
          id: `mcp:${ids.newId()}`,
          name: request.params.name,
          arguments: request.params.arguments ?? {},
        },
        context.mcpReq.signal,
      );

      return server.projectCallToolResult(
        mapToolResult(outcome),
        outputSchemas.get(request.params.name),
      );
    } catch (error) {
      // The mapper's static unknown-tool error is the only InvalidParams thrown in this block.
      if (error instanceof ProtocolError && error.code === ProtocolErrorCode.InvalidParams) {
        throw error;
      }

      throw internalError();
    } finally {
      inFlight -= 1;
    }
  });

  return server;
}
