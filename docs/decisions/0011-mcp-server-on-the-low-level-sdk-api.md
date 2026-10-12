# 0011 — MCP server on the SDK's low-level API, with caller-owned keys and dual-era stdio

Status: accepted — 2026-10-11

## Context

[Decision 0002](0002-canonical-tool-registry.md) fixed that MCP and OpenAI share one tool registry
and one executor, and [decision 0004](0004-stdio-mcp-transport.md) fixed stdio as the v1 transport.
Building the server raised four choices the earlier records left open: how to use the official
TypeScript SDK (v2, implementing the 2026-07-28 spec) without bypassing the executor; which
protocol versions to serve; where an idempotency key comes from over MCP; and how to bound
concurrent calls.

What the SDK does, verified in its source and by experiment:

- `McpServer.registerTool` validates arguments itself and words its own errors, and a handler's
  thrown error reaches the client with its original message. Both would bypass the executor's safe
  messages.
- `serveStdio` serves the 2026-07-28 era (no `initialize`; per-request metadata) and the 2025-11-25
  era (`initialize`) from one process.
- Handlers run concurrently with no limit (40 000 simultaneous calls were accepted), the spec says
  servers must rate-limit tool invocations, and cancellation sends no response but does not stop a
  handler that ignores its signal.
- The protocol has no session and changes a request id on retry, so a server has nothing stable to
  derive an idempotency key from.

## Decision

- **Low-level `Server`.** Two handlers, `tools/list` and `tools/call`. Descriptors are projected from
  the canonical definitions; every call goes through the one executor, with a host-generated call id,
  the request's `AbortSignal`, and the arguments untouched. The handler throws only static protocol
  errors.
- **Both eras,** through `serveStdio`; only the `tools` capability is declared.
- **The caller owns the idempotency key.** The canonical schema is exposed unchanged, including the
  required `idempotencyKey`; the adapter never derives, generates, or rewrites a key. Deriving one
  from the arguments would merge two intentional identical writes.
- **Results:** `structuredContent` plus one JSON text block built from the same validated object. An
  unknown tool is the one JSON-RPC error (-32602, static message); every other failure is an
  `isError` result.
- **A concurrency cap,** `MCP_MAX_IN_FLIGHT_CALLS` (default 16, 1–128): the call over the limit is
  refused with `server_busy` before the executor, so no handler runs and no key is consumed. It is
  not request-rate limiting and does not count handlers that outlive a cancellation or a timeout (the
  executor's handler ledger bounds those, M6).
- **Bounded input and an honest end:** the stdio transport reads at most 1 MiB per message; an
  oversized message ends the process with exit 1, never 0, and releases stdin so it cannot hang.
  Confirmation fails closed (`confirmation_required`) until M6.

## Consequences

- The MCP surface adds no logic that can drift from the CLI's: one definition, one executor, one set
  of messages. A new tool appears over MCP by being registered.
- A client whose model invents a fresh key on a retry creates a second note; the guarantee stays
  "at most one effect per key".
- A cancelled or timed-out call leaves its outcome unknown to the client; the recovery is a retry
  with the same key. The server never claims otherwise.
- Two in-flight requests that reuse one JSON-RPC id cannot be rejected safely through the SDK's
  public API, and a cancellation for that id reaches only the later one. This is documented, not
  worked around.
- The SDK is new: its behaviour is pinned by tests (exact version `2.3.1`), and an upgrade is a
  reviewed change.
- A global `console` replacement was rejected as unnecessary: nothing loaded writes to stdout, and
  an architecture test plus a real-process test guard stdout instead.

## Alternatives considered

- `McpServer.registerTool` — bypasses the executor's validation and error wording.
- A key derived by the server from the arguments or the request id — wrongly merges intentional
  repeats, or changes on retry.
- Serving only one protocol era — would exclude clients on the other.
- No concurrency cap until M6 — leaves the spec's rate-limit requirement entirely open while the
  SDK accepts unbounded concurrent calls.
