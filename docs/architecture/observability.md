# Observability

Structured logging and timing events.

## Logging

- pino behind the `Logger` port (`src/ports/logger.ts` → `src/adapters/logging/pino-logger.ts`).
- JSON lines to **stderr** in every process (stdout is reserved for command output and MCP
  protocol traffic). Synchronous destination, so nothing is lost on exit.
- Messages are constant dotted event names (`turn.started`, `tool.timed_out`); data goes in fields.
- Known secret fields are redacted (`apiKey`, `authorization`, `OPENAI_API_KEY`, one level deep).
- Level from `LOG_LEVEL` (default `info`).
- Never log full prompts, transcripts, tool payloads, or raw audio by default.

## Correlation fields

`turnId`, `toolCallId`, `toolName`, `provider`, `durationMs`, `attempt`, `outcome`.

## Events worth logging

Turn started/completed/failed; transcription started/completed; model request completed; tool
completed/failed; TTS started/completed; MCP client connected/disconnected where available;
graceful shutdown.

## Tool events

The executor logs exactly one outcome event per tool call: `tool.completed` (info) or `tool.failed`
(warn; error for `internal_error` and `invalid_output`, which point at a defect). Fields:
`toolCallId` (only when it matches `^[A-Za-z0-9_.:-]{1,128}$`, otherwise `null`: the id comes from
the host and is never trusted as a log value), `toolName` (an unregistered name only when it has a
tool name's form, otherwise `null`), `risk`,
`outcome` (`ok` or the error code), `handlerInvoked`, `durationMs`, and per outcome `issueCount`,
`failureReason`, output issue paths and codes, `resultBytes`, or the thrown error's name and
message. Arguments and outputs are never logged.

When a handler settles after the executor already returned `cancelled` or `timed_out`, the executor
logs `tool.settled_late` (warn): `toolCallId`, `toolName`, `risk`, `durationMs` from the call's
start, and `lateOutcome` — `returned`, `failed` with the declared `failureReason`, or `threw` with
only the thrown value's `errorName`. It is the evidence that a write reported as "outcome unknown"
did complete. It never changes the caller's result and never logs output or thrown data. A handler
that never settles logs nothing more.

## Note store events

The file note store logs `note_store.unavailable` (warn: `operation`, `phase`, `errorCode`),
`note_store.unreadable` (error: `operation`, `noteId`, `problem`), and
`note_store.temp_cleanup_failed` (warn: `errorCode`). `errorCode` is a system error code such as
`ENOENT`, never an error message, which would carry an absolute path. Note text, idempotency keys,
paths, and stored file contents are never logged; `noteId` is a one-way hash of the key.

## Metrics

No metrics backend. Structured timing events (transcription, model per iteration, tool, TTS, total
turn) that could later feed OpenTelemetry or Prometheus. OpenTelemetry traces are a stretch goal.
