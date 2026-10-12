# Tool system

The architectural centerpiece: a tool is defined once and every caller — the OpenAI agent loop and
the MCP server — derives from that definition and executes through one executor. Status: the
definition, registry, executor, and two read-only tools are built (M1); `create_note` and
`read_note` on a file-backed note store are built (M2); idempotency metadata, the model-facing
schema projection, and the agent loop's use of both are built (M3); the MCP server derives its tool
descriptors from the same registry and runs every call through the same executor (M5).

## Tool definition

`src/tools/tool-definition.ts` holds the contract every tool is written against. It lives in
`src/tools/`, not `src/app/`, because tools may import only domain and ports. A tool author calls
`defineTool(spec)` from `src/tools/<tool-name>/` with:

| Field | Rule |
| --- | --- |
| `name` | Stable `snake_case`, at most 64 characters, unique across the registry |
| `description` | Precise enough for model selection: when to use it and when not to |
| `inputSchema` | A Zod object (`z.strictObject`): rejects unknown keys, every property required and described (nullable instead of optional), strings bounded |
| `outputSchema` | A strict Zod object over JSON values; no transforms, so its input and output types match |
| `risk` | `read`, `write`, `destructive`, or `external`; a `destructive` tool must set `requiresConfirmation: true` (enforced by the type) |
| `timeoutMs` | Per-tool execution budget: an integer from 1 to 2³¹−1 |
| `requiresConfirmation` | Whether the host must obtain confirmation before execution |
| `idempotency` | `"key"` when the input takes the canonical required `idempotencyKey`, otherwise `"none"` ([write tools](#write-tools-and-idempotency)) |
| `failures` | Expected failure reasons, each with a static, client-safe message |
| `execute(input, context)` | Receives validated input; returns `ok(output)` or `err(reason)` |

Types are inferred from the schemas. `defineTool` is the only generic step: inside it the parsed
input provably matches the handler's parameter, and it returns a non-generic `ToolDefinition`
whose `bindArguments(call)` validates untrusted arguments and returns the handler bound to the
parsed input. The registry therefore holds tools with different input and output types without
`any` or casts. Callers receive a validated JSON object, not a per-tool type: every caller
dispatches by name, so none could use one.

The handler's context holds only what every tool may use — the `AbortSignal` and the `Clock`.
A tool that needs a port is built by a factory that receives exactly that port
(`defineCreateNoteTool(notes)`), and the composition root wires it, so no tool can reach another
tool's dependencies. Never the OpenAI client, never MCP or OpenAI types.

### Expected failures stay client-safe

A handler reports an expected failure by returning a declared reason — `err("division_by_zero")`
— never text. The message shown to a model or MCP client is the static string declared for that
reason in `failures`, so a runtime value such as a caught error's message cannot reach a client:
`err(error.message)` does not compile, because reasons are inferred only from `failures`. Its
keys must be literals: `defineTool` rejects a table typed with `string` or template-pattern keys
(such as `Record<string, string>` or one built with `Object.fromEntries`) and an explicit `string`
reason type, since any of these would let runtime text through as a reason. A reason
names an expected domain condition decided by the tool; never convert a generic `catch` into one.
Anything a handler throws becomes `internal_error` with a generic message, and its cause goes only
to the error log.

## Registry

- `src/app/tools/tool-registry.ts`: the set of definitions, looked up by exact, case-sensitive
  name with a `Map`. `constructor`, `__proto__`, or a name with different case or whitespace does
  not resolve.
- Built once by the composition root. At startup it throws for a duplicate name, an invalid name,
  an out-of-range `timeoutMs`, an `idempotency` value that disagrees with the input schema (in
  either direction), or a declared failure message over the byte bound below.
- From the registry come the model-facing function tools (`src/app/agent/model-tools.ts`), the
  `voice-agent tools` catalog, and the MCP tool descriptors (`src/adapters/mcp/mcp-tool-descriptors.ts`,
  which keeps `idempotencyKey` visible). No hand-written OpenAI or MCP tool definitions exist
  anywhere.
- The model-facing schema is projected from the canonical Zod schema: for a `key` tool,
  `idempotencyKey` is omitted on a new schema (the canonical one is never changed), then converted
  to JSON Schema. A projection that is not strict-compatible — an open object or an optional
  property at any depth — throws at startup.

## Executor pipeline

`src/app/tools/tool-executor.ts`. Every caller goes through it, and it never throws:

```
lookup exact registered tool → validate input → policy (confirmation) → caller already cancelled?
  → handler ledger → spend the grant → deadline + execute → validate output → result size cap → one outcome log event → Result
```

Only the executor calls `bindArguments`, so no code reaches a handler any other way
(`tests/architecture/tool-execution-path.test.ts`). The policy step fails closed: a tool that
requires confirmation runs only if the call carries a host-issued `ConfirmationGrant` for that tool
name and call id, which the executor spends exactly when it admits the handler; otherwise it is
refused with `confirmation_required`. The exact order is validation, then the confirmation check,
then the cancellation check, then the handler ledger, then spending the grant, then the handler.
So an unconfirmed call is refused even if cancelled, an invalid call is `invalid_input` whether or
not it carries a grant, and a cancelled or overloaded call does not use its grant up. See
[security](security.md#confirmation).

### Outcomes

Every failure carries a stable `code` and a message that is safe to show a model or MCP client.

| Code | Handler invoked? | Effect on the world |
| --- | --- | --- |
| `unknown_tool`, `invalid_input`, `confirmation_required`, `overloaded` | no | none |
| success | yes, finished | done |
| `execution_failed` | yes, finished | the tool's declared expected failure |
| `invalid_output`, `output_too_large` | yes, finished | effects done, result withheld |
| `timed_out`, `cancelled`, `internal_error` | maybe | unknown |

Callers must treat an unknown outcome as "may have executed". A `cancelled` call whose handler
never started is in fact effect-free, but it shares the conservative meaning so callers have one
rule; the log field `handlerInvoked` tells operators which it was.

`invalid_input` messages list each issue's path with Zod's message: at most ten, and only as many
as keep the message within `MAX_TOOL_ERROR_MESSAGE_JSON_BYTES` (1024 bytes, measured as the UTF-8
length of the message's JSON string, so escaping counts); the rest are counted, and if not even one
fits the message is a fixed `Invalid arguments.`. Every other error message is a fixed string or a
declared failure message, which the registry also holds to that bound. Zod's built-in
messages name the expected type or limit, not the rejected value, and unknown property names are
omitted because they come from the caller. Two things are not guarded by the executor, so tool
schemas must avoid them: a custom message (from `refine` or an `error` option) is passed through
as written and must not include the input, and a key of a record-shaped input (`z.record`) appears
in the issue path, so tool inputs use fixed property names, not records.

### Timeouts and cancellation

`timed_out` means the executor stopped waiting. It does **not** mean the handler stopped. At the
deadline the executor aborts the handler's `context.signal`, but JavaScript cannot terminate a
promise: a handler that ignores its signal keeps running and may complete a side effect after the
caller has received `timed_out`. `cancelled` has the same semantics. This is harmless for
read-only tools and is why every write tool takes a required idempotency key
([write tools](#write-tools-and-idempotency)). When such a handler settles after all, the executor
logs `tool.settled_late`; the caller's result never changes
([observability](observability.md#tool-events)).

### Unsettled handlers

Because a handler cannot be stopped, the executor keeps a **handler ledger**
(`src/app/tools/handler-ledger.ts`). A handler enters it just before it is invoked and leaves it
only when its own promise settles, never when the executor returns. Until then it is *active*; when
the executor stops waiting (a deadline or a cancellation) while it still runs, it becomes
*abandoned*. A call that fails validation, needs confirmation, or was cancelled before invocation
never enters the ledger.

When `MAX_ABANDONED_TOOL_HANDLERS` handlers are already abandoned (default 3, 1–64), a new call
is refused with `overloaded` before its handler is invoked: no handler runs, no idempotency key is
consumed, and the message is fixed ("Too many earlier tool calls are still running; retry later.").
The next call is admitted as soon as one abandoned handler settles. The limit counts abandoned
handlers only, so the number of calls running at once is bounded by whoever admits calls: the agent
loop runs them one at a time, and over MCP `MCP_MAX_IN_FLIGHT_CALLS` caps them. Calls already
running when the limit is reached are not stopped, so a burst can leave more abandoned handlers than
the limit; it stops further calls.

The ledger holds two counters and one shared "idle" signal: no per-call state. It exposes
`idle()`, which resolves when no invoked handler is unsettled; the MCP shutdown waits on it, up to its
grace ([MCP](mcp.md#shutdown)).

The deadline is `timeoutMs` from the definition. A caller's limit — a turn deadline, a client
disconnect — arrives as the caller's `AbortSignal`; there is no separate configured tool-timeout
ceiling.

When waiting ends, the outcome is decided once, from the abort flags, never from which promise won
the race or from the abort reason:

1. the caller's signal is aborted → `cancelled`;
2. otherwise the deadline fired → `timed_out`;
3. otherwise the handler's own outcome.

A handler result that arrives in the same turn as an abort is reported as the abort. If the caller
has already cancelled before the handler would start, the result is `cancelled` and the handler is
never invoked.

### Result size cap

`MAX_TOOL_RESULT_BYTES` bounds the UTF-8 byte length of the serialised JSON result that leaves the
executor. It does not bound memory or CPU a handler uses, or the size of an object a handler builds
before it is validated and measured. Argument size is bounded by the provider's output limit in the
agent loop (`OPENAI_MAX_OUTPUT_TOKENS`), by the 1 MiB transport limit over MCP, and by schema limits such
as `maxLength`.

## Write tools and idempotency

A write retried after an unknown outcome must not repeat its effect
([decision 0008](../decisions/0008-idempotent-note-creation.md)):

- Every `write` tool takes a required, non-null, bounded `idempotencyKey`
  (`tests/contract/tool-registry.test.ts`). There is no keyless write path.
- A tool that takes the key declares `idempotency: "key"`; `defineTool` refuses `"key"` unless the
  parsed input has a required `idempotencyKey` string, and the registry checks the declaration
  against the schema in both directions. The agent loop discovers host-owned keys only from this
  metadata, never from the tool's name or risk.
- The key belongs to the caller of the executor. In the agent loop that is the host: the field is
  absent from the model-facing schema, and the runner derives the key from the turn, the tool, and
  the other arguments ([agent loop](agent-loop.md#arguments-and-host-owned-keys)), replacing any key
  the model sends. An MCP client supplies its own: the field stays in the MCP schema and the adapter
  never changes it ([MCP](mcp.md#idempotency)).
- `create_note`: one key names one note. The same key and the same text replay the original note
  with `created: false`; the same key and different text fail with `idempotency_key_conflict`;
  different keys create different notes, even with the same text. Text is compared exactly.
- The key's scope is the whole note store, across processes and restarts; it lives as long as its
  note. Duplicate suppression is at most one note per key, never "exactly once": a caller that
  retries with a new key creates a new note.

What each `create_note` outcome means for the caller:

| Outcome | Note for this key |
| --- | --- |
| `ok`, `created: true` | written by this call |
| `ok`, `created: false` | written earlier by a call with the same key; this call wrote nothing |
| `execution_failed` (`idempotency_key_conflict`, `note_unreadable`, `note_quota_exceeded`, `storage_unavailable`) | this call wrote nothing; retrying the same request is safe (a full store refuses new keys, never replays) |
| `invalid_input`, `unknown_tool` | nothing written |
| `invalid_output` | written; the result was withheld, and a retry with the same key replays it |
| `timed_out`, `cancelled`, `internal_error` | unknown; retry with the same key |

The store's commit point and its guarantees are in [security](security.md#filesystem-safety).

## Initial tools

| Tool | Risk | Proves | Milestone |
| --- | --- | --- | --- |
| `get_current_time` | read | `Clock` port, schema validation, OpenAI/MCP reuse | M1 |
| `calculate` | read | Operation enum + numeric inputs, no `eval`, declared failures | M1 |
| `create_note` | write | Side effects, required idempotency key, persistence port, atomic publication | M2 |
| `read_note` | read | Not-found semantics, validated reads of persisted data | M2 |
| `delete_note` | destructive | Confirmation policy and audit event — only after the policy exists | M6 (optional) |

## Adding a tool

1. Create `src/tools/<tool-name>/<tool-name>-tool.ts`. A tool that needs a port exports a factory
   (`define<Name>Tool(port)`) instead of a constant.
2. Define strict input and output Zod schemas; describe every input property.
3. Define metadata (name, description, risk, timeout, confirmation, idempotency) and the expected
   `failures`, each message within 1024 serialised bytes. A `write` tool takes a required
   `idempotencyKey`, declares `idempotency: "key"`, and must make a repeated key a no-op.
4. Implement `execute` against the tool context; return `ok(output)` or `err(reason)`.
5. Add the definition to the registry in `src/bootstrap/create-application.ts`.
6. Add unit tests through the executor (valid, invalid input, each failure reason; idempotency if
   it writes). `tests/contract/tool-registry.test.ts` checks the new tool automatically.
7. The agent loop and the MCP server expose it automatically.
