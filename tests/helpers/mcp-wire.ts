import { z } from "zod";
import type { JsonObject } from "../../src/domain/json-value.js";
import type { McpChild } from "./mcp-child.js";

/** The 2026-07-28 per-request envelope every modern request carries. */
const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "stdio-test", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": {},
};

export function modernRequest(id: number, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: "2.0", id, method, params: { ...params, _meta: MODERN_META } };
}

export function callToolRequest(id: number, name: string, args: JsonObject): JsonObject {
  return modernRequest(id, "tools/call", { name, arguments: args });
}

export function cancelNotification(requestId: number): JsonObject {
  return {
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId, _meta: MODERN_META },
  };
}

const toolResultSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    structuredContent: z.record(z.string(), z.json()).optional(),
  }),
});

export type ToolResult = z.output<typeof toolResultSchema>["result"];

/** The `tools/call` result the child answered request `id` with. */
export async function toolResultOf(child: McpChild, id: number): Promise<ToolResult> {
  return toolResultSchema.parse(await child.whenResponse(id)).result;
}
