import {
  InMemoryTransport,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type JSONRPCResponse,
  type RequestId,
} from "@modelcontextprotocol/server";
import type { JsonObject } from "../../src/domain/json-value.js";
import type { Logger } from "../../src/ports/logger.js";
import { buildMcpServer, type McpHarnessOptions } from "./mcp-harness.js";
import { createRecordingLogger } from "./recording-logger.js";

export interface RawMcpPeer {
  /** Every message the server sent, in order. */
  readonly received: readonly JSONRPCMessage[];
  /** Sends a JSON-RPC request with exactly this id: the official client never reuses ids. */
  request(id: RequestId, method: string, params: JsonObject): Promise<void>;
  notify(method: string, params: JsonObject): Promise<void>;
  /** Responses and errors the server sent for this id. */
  responsesTo(id: RequestId): readonly JSONRPCResponse[];
  whenResponse(id: RequestId): Promise<JSONRPCResponse>;
  /**
   * Resolves after the server has handled everything sent before it: messages are delivered in
   * order, so any response owed to earlier requests has been sent by the time this one answers.
   */
  settle(): Promise<void>;
  /** Closes only the client side of the transport, as a client that went away would. */
  disconnect(): Promise<void>;
  close(): Promise<void>;
}

function responseId(message: JSONRPCMessage): RequestId | undefined {
  return isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)
    ? message.id
    : undefined;
}

/**
 * Talks to the server as bare JSON-RPC over the in-memory transport, so a test can send what the
 * official client never would (duplicate ids, cancel notifications at chosen moments). The
 * connection is initialised as a 2025-era client.
 */
export async function connectRawMcp(
  options: McpHarnessOptions,
  logger: Logger = createRecordingLogger(),
): Promise<RawMcpPeer> {
  const server = buildMcpServer(options, logger);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const received: JSONRPCMessage[] = [];
  const listeners: (() => void)[] = [];
  let sentinels = 0;

  clientTransport.onmessage = (message): void => {
    received.push(message);

    for (const listener of [...listeners]) {
      listener();
    }
  };

  await server.connect(serverTransport);
  await clientTransport.start();

  const responsesTo = (id: RequestId): readonly JSONRPCResponse[] =>
    received.filter(
      (message): message is JSONRPCResponse =>
        responseId(message) === id &&
        (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)),
    );

  const whenResponse = async (id: RequestId): Promise<JSONRPCResponse> =>
    new Promise((resolve) => {
      const check = (): void => {
        const [first] = responsesTo(id);

        if (first !== undefined) {
          listeners.splice(listeners.indexOf(check), 1);
          resolve(first);
        }
      };

      listeners.push(check);
      check();
    });

  const request = async (id: RequestId, method: string, params: JsonObject): Promise<void> =>
    clientTransport.send({ jsonrpc: "2.0", id, method, params });

  await request("init", "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "raw-peer", version: "0.0.0" },
  });
  await whenResponse("init");
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  return {
    received,
    request,
    notify: async (method, params): Promise<void> =>
      clientTransport.send({ jsonrpc: "2.0", method, params }),
    responsesTo,
    whenResponse,
    settle: async (): Promise<void> => {
      sentinels += 1;
      await request(`settle-${sentinels}`, "tools/list", {});
      await whenResponse(`settle-${sentinels}`);
    },
    disconnect: async (): Promise<void> => clientTransport.close(),
    close: async (): Promise<void> => {
      await clientTransport.close();
      await server.close();
    },
  };
}
