# 0012 — A thrown value is never logged, only its class

Status: accepted — 2026-10-11

## Context

The tool executor turns anything a handler throws into the static `internal_error` result and logs
the failure. It first logged the thrown error's name and the first 500 characters of its message,
and its own test asserted a password in a message appeared in the log. An MCP client usually
captures a server's stderr into its own log files, and exceptions routinely hold paths, connection
strings, or request data. Truncating a message is not redacting it. The error's `name` was logged
too, with no length cap, and it is as handler-controlled as the message.

## Decision

The executor logs `errorClass` only, in `tool.failed` and `tool.settled_late`: one of a fixed
allowlist of built-in names (`Error`, `TypeError`, `RangeError`, `SyntaxError`, `ReferenceError`,
`EvalError`, `URIError`, `AggregateError`, `AbortError`, `TimeoutError`), else `other_error`; and
`non_error_thrown` or `unreadable_error` for values that are not errors or cannot be read. The
message, stack, cause, and any name outside the allowlist are never read into a log field.
Execution, timeouts, cancellation, results, and public messages are unchanged.

## Consequences

- No secret in an exception can reach stderr through the executor, in the CLI or over MCP.
- A custom error subclass shows as `other_error` (or its built-in parent). Diagnosing a defect needs
  a reproduction, not the log line; that is the deliberate cost.
- The class `AbortError` keeps the evidence that a handler stopped on the executor's signal.
- Tests with the real pino logger and hostile errors (secret messages, names, causes, stacks,
  subclasses, non-errors, late rejections) pin the behaviour.

## Alternatives considered

- Truncate or scrub the message — a pattern cannot recognise every secret.
- Strip the message only in the MCP process — leaves the same leak in the CLI and splits the rule.
- Log the error's name — handler-controlled and uncapped.
