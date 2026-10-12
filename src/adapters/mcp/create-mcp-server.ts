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
import type { CallAdmission, RefusalReason } from "./call-admission.js";
import { mapToolResult } from "./mcp-result-mapper.js";
import { createMcpToolDescriptors } from "./mcp-tool-descriptors.js";

export interface McpServerDependencies {
  readonly serverInfo: Implementation;
  /** The canonical registry: the only source of the tools this server lists. */
  readonly tools: ToolRegistry;
  /** The canonical executor: the only way this server runs a tool. */
  readonly executeTool: ToolExecutor;
  readonly ids: IdGenerator;
  /**
   * Decides which `tools/call` requests may run: the rate limit, then the in-flight cap. One per
   * process, shared by every server instance the SDK builds for a connection.
   */
  readonly admission: CallAdmission;
}

const REFUSALS = {
  server_busy: {
    code: "server_busy",
    message: "Too many tool calls are in flight; retry later.",
  },
  rate_limited: {
    code: "rate_limited",
    message: "Too many tool calls; retry after a short delay.",
  },
  shutting_down: {
    code: "server_shutting_down",
    message: "The server is shutting down; this call was not run.",
  },
} satisfies {
  readonly [Reason in RefusalReason]: { readonly code: string; readonly message: string };
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
 * Calls run concurrently, under the admission policy: a call over the rate limit is refused with
 * `rate_limited`, one over the in-flight cap with `server_busy`, both before the executor (and so
 * any handler) is reached, and its slot is released whenever the executor returns. A handler that
 * outlives a `cancelled` or `timed_out` result no longer holds a slot; the executor's handler
 * ledger bounds those.
 *
 * The SDK sends a thrown error's own message to the client, so the call handler throws only
 * static `ProtocolError`s: the unknown-tool error from the mapper, or "Internal error".
 */
export function createMcpServer(dependencies: McpServerDependencies): Server {
  const { executeTool, ids, admission } = dependencies;
  const descriptors = createMcpToolDescriptors(dependencies.tools.tools);
  const outputSchemas = new Map(descriptors.map((tool) => [tool.name, tool.outputSchema]));
  const server = new Server(dependencies.serverInfo, { capabilities: { tools: {} } });

  server.setRequestHandler("tools/list", () => ({ tools: [...descriptors] }));

  server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
    const admitted = admission.admit();

    if (!admitted.ok) {
      return mapToolResult(err(REFUSALS[admitted.reason]));
    }

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
      admitted.release();
    }
  });

  return server;
}
