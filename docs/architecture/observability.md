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
requested/validated; confirmation required; tool completed/failed/timed out; TTS
started/completed; MCP client connected/disconnected where available; graceful shutdown.

## Metrics

No metrics backend. Structured timing events (transcription, model per iteration, tool, TTS, total
turn) that could later feed OpenTelemetry or Prometheus. OpenTelemetry traces are a stretch goal.
