import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import type { JsonValue } from "../../src/domain/json-value.js";

/** RFC 6455's fixed GUID for the `Sec-WebSocket-Accept` handshake value. */
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OPCODE_TEXT = 0x1;

const OPCODE_BINARY = 0x2;

const OPCODE_CLOSE = 0x8;

export interface FakeRealtimeServerOptions {
  /** Never answers the HTTP upgrade. */
  readonly stallHandshake?: boolean;
  /** Answers the upgrade with this HTTP status instead of switching protocols. */
  readonly rejectHandshakeStatus?: number;
  /** Never answers a client close frame and never ends the TCP connection itself. */
  readonly ignoreClose?: boolean;
}

/** One client connection as the server sees it. */
export interface RealtimeConnection {
  readonly headers: IncomingHttpHeaders;
  readonly url: string;
  /** Client text frames, parsed as JSON, in arrival order. */
  readonly received: readonly JsonValue[];
  /** The next client event not yet taken. */
  nextEvent(): Promise<JsonValue>;
  sendJson(event: JsonValue): void;
  sendText(text: string): void;
  sendBinary(bytes: Uint8Array): void;
  /** Sends a close frame with `code` and ends the TCP connection. */
  close(code: number): void;
  /** Resolves when the TCP connection ended, by either side. */
  readonly ended: Promise<void>;
  /** Whether the client sent a close frame. */
  readonly clientClosed: () => boolean;
}

export interface FakeRealtimeServer {
  /** `ws://127.0.0.1:<port>/v1/realtime`. */
  readonly url: string;
  /** Upgrade requests received, including stalled and rejected ones. */
  readonly upgrades: () => number;
  readonly connections: readonly RealtimeConnection[];
  nextConnection(): Promise<RealtimeConnection>;
  /** Drops every connection and stops listening. */
  close(): Promise<void>;
}

const tcpAddressSchema = z.object({ port: z.number().int().positive() });

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const first = 0x80 | opcode;

  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  }

  if (payload.length < 65_536) {
    const header = Buffer.from([first, 126, 0, 0]);

    header.writeUInt16BE(payload.length, 2);

    return Buffer.concat([header, payload]);
  }

  const header = Buffer.alloc(10);

  header[0] = first;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);

  return Buffer.concat([header, payload]);
}

interface DecodedFrame {
  readonly opcode: number;
  readonly payload: Buffer;
  readonly size: number;
}

/** Where a frame's payload starts and how long it is. */
interface PayloadBounds {
  readonly offset: number;
  readonly length: number;
}

/** The payload bounds from the 7-, 16-, or 64-bit length field. */
function payloadBounds(buffer: Buffer, shortLength: number): PayloadBounds {
  if (shortLength === 126) {
    return { offset: 4, length: buffer.length >= 4 ? buffer.readUInt16BE(2) : Infinity };
  }

  if (shortLength === 127) {
    return {
      offset: 10,
      length: buffer.length >= 10 ? Number(buffer.readBigUInt64BE(2)) : Infinity,
    };
  }

  return { offset: 2, length: shortLength };
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  return Buffer.from(payload.map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
}

/** The first complete (masked, client-sent) frame in `buffer`, or `null` if it is incomplete. */
function decodeFrame(buffer: Buffer): DecodedFrame | null {
  const first = buffer[0];
  const second = buffer[1];

  if (first === undefined || second === undefined) {
    return null;
  }

  const { offset, length } = payloadBounds(buffer, second & 0x7f);
  const maskBytes = (second & 0x80) === 0 ? 0 : 4;
  const size = offset + maskBytes + length;

  if (buffer.length < size) {
    return null;
  }

  const payload = buffer.subarray(size - length, size);
  const mask = maskBytes === 0 ? Buffer.alloc(4) : buffer.subarray(offset, offset + 4);

  return { opcode: first & 0x0f, payload: unmask(payload, mask), size };
}

/** A queue the test reads from as items arrive. */
interface Queue<T> {
  push(item: T): void;
  next(): Promise<T>;
}

function createQueue<T>(): Queue<T> {
  const items: T[] = [];
  const waiters: ((item: T) => void)[] = [];

  return {
    push: (item: T): void => {
      const waiter = waiters.shift();

      if (waiter === undefined) {
        items.push(item);
      } else {
        waiter(item);
      }
    },
    next: async (): Promise<T> => {
      const item = items.shift();

      return item === undefined ? new Promise<T>((resolve) => waiters.push(resolve)) : item;
    },
  };
}

function accept(
  request: { headers: IncomingHttpHeaders; url?: string | undefined },
  socket: Duplex,
  options: FakeRealtimeServerOptions,
): RealtimeConnection {
  const key = request.headers["sec-websocket-key"] ?? "";
  const acceptValue = createHash("sha1").update(`${key}${HANDSHAKE_GUID}`).digest("base64");
  const received: JsonValue[] = [];
  const events = createQueue<JsonValue>();
  const ended = Promise.withResolvers<void>();
  let pending = Buffer.alloc(0);
  let clientClosed = false;

  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptValue}\r\n\r\n`,
  );

  socket.on("close", () => ended.resolve());
  socket.on("data", (data: Buffer) => {
    pending = Buffer.concat([pending, data]);

    for (let frame = decodeFrame(pending); frame !== null; frame = decodeFrame(pending)) {
      pending = pending.subarray(frame.size);

      if (frame.opcode === OPCODE_TEXT) {
        const event = z.json().parse(JSON.parse(frame.payload.toString("utf8")));

        received.push(event);
        events.push(event);
      } else if (frame.opcode === OPCODE_CLOSE) {
        clientClosed = true;

        if (options.ignoreClose !== true) {
          socket.end(encodeFrame(OPCODE_CLOSE, Buffer.from([0x03, 0xe8])));
        }
      }
    }
  });

  const send = (opcode: number, payload: Buffer): void => {
    if (!socket.destroyed && socket.writable) {
      socket.write(encodeFrame(opcode, payload));
    }
  };

  return {
    headers: request.headers,
    url: request.url ?? "",
    received,
    nextEvent: async () => events.next(),
    sendJson: (event) => send(OPCODE_TEXT, Buffer.from(JSON.stringify(event))),
    sendText: (text) => send(OPCODE_TEXT, Buffer.from(text)),
    sendBinary: (bytes) => send(OPCODE_BINARY, Buffer.from(bytes)),
    close: (code) => {
      const payload = Buffer.alloc(2);

      payload.writeUInt16BE(code);
      socket.end(encodeFrame(OPCODE_CLOSE, payload));
    },
    ended: ended.promise,
    clientClosed: () => clientClosed,
  };
}

/**
 * A Realtime-like WebSocket server on loopback, scripted by the test, so the adapter runs against
 * the platform's real `WebSocket` client: real handshakes, frames, and close behaviour.
 */
export async function startFakeRealtimeServer(
  options: FakeRealtimeServerOptions = {},
): Promise<FakeRealtimeServer> {
  const sockets = new Set<Duplex>();
  const connections: RealtimeConnection[] = [];
  const incoming = createQueue<RealtimeConnection>();
  let upgrades = 0;

  const server = createServer();

  server.on("upgrade", (request, socket) => {
    upgrades += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));

    if (options.stallHandshake === true) {
      return;
    }

    if (options.rejectHandshakeStatus !== undefined) {
      socket.end(`HTTP/1.1 ${options.rejectHandshakeStatus} Rejected\r\nContent-Length: 0\r\n\r\n`);

      return;
    }

    const connection = accept(request, socket, options);

    connections.push(connection);
    incoming.push(connection);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = tcpAddressSchema.parse(server.address());

  return {
    url: `ws://127.0.0.1:${port}/v1/realtime`,
    upgrades: () => upgrades,
    connections,
    nextConnection: async () => incoming.next(),
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
