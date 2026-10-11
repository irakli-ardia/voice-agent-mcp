import {
  type CallToolResult,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import type { JsonObject } from "../../domain/json-value.js";
import type { Result } from "../../domain/result.js";

/** A failed call as MCP clients see it: the executor's error, or `server_busy` from this adapter. */
export interface McpCallFailure {
  readonly code: string;
  /** Always a fixed or already-bounded message that is safe to show a model. */
  readonly message: string;
}

/**
 * Maps one call's outcome to the MCP result. A success carries the validated canonical object
 * twice, built from that one value so the copies cannot disagree: as `structuredContent`, and as
 * the JSON text MCP asks for beside it. A failure is a tool execution error (`isError`) whose text
 * is `<code>: <message>`.
 *
 * An unknown tool is the one protocol error: the spec files it under JSON-RPC errors, so it throws
 * `ProtocolError` (-32602) with the executor's static message, never the requested name.
 */
export function mapToolResult(result: Result<JsonObject, McpCallFailure>): CallToolResult {
  if (result.ok) {
    return {
      structuredContent: result.value,
      content: [{ type: "text", text: JSON.stringify(result.value) }],
    };
  }

  if (result.error.code === "unknown_tool") {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, result.error.message);
  }

  return {
    isError: true,
    content: [{ type: "text", text: `${result.error.code}: ${result.error.message}` }],
  };
}
