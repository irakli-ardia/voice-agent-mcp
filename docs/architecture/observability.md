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

The executor logs exactly one event per tool call: `tool.completed` (info) or `tool.failed` (warn;
error for `internal_error` and `invalid_output`, which point at a defect). Fields: `toolCallId`,
`toolName` (an unregistered name only when it has a tool name's form, otherwise `null`), `risk`,
`outcome` (`ok` or the error code), `handlerInvoked`, `durationMs`, and per outcome `issueCount`,
`failureReason`, output issue paths and codes, `resultBytes`, or the thrown error's name and
message. Arguments and outputs are never logged.

## Metrics

No metrics backend. Structured timing events (transcription, model per iteration, tool, TTS, total
turn) that could later feed OpenTelemetry or Prometheus. OpenTelemetry traces are a stretch goal.
