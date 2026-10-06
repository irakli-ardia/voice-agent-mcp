# Tool system

The architectural centerpiece: a tool is defined once and every caller — the OpenAI agent loop and
the MCP server — derives from that definition and executes through one executor. Status: the
definition, registry, executor, and two read-only tools are built (M1); side-effect tools follow in
M2.

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
| `failures` | Expected failure reasons, each with a static, client-safe message |
| `execute(input, context)` | Receives validated input; returns `ok(output)` or `err(reason)` |

Types are inferred from the schemas. `defineTool` is the only generic step: inside it the parsed
input provably matches the handler's parameter, and it returns a non-generic `ToolDefinition`
whose `bindArguments(call)` validates untrusted arguments and returns the handler bound to the
parsed input. The registry therefore holds tools with different input and output types without
`any` or casts. Callers receive a validated JSON object, not a per-tool type: every caller
dispatches by name, so none could use one.

The handler's context holds only explicitly permitted dependencies — today the `AbortSignal` and
the `Clock`. Later milestones add what their tools need. Never the OpenAI client, never MCP or
OpenAI types.

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
- Built once by the composition root; a duplicate name, an invalid name, or an out-of-range
  `timeoutMs` throws at startup.
- From the registry, adapters derive OpenAI function-tool metadata (M3), MCP tool registration
  (M5), and the `tools` catalog (M3). No hand-written OpenAI or MCP tool definitions exist anywhere.

## Executor pipeline

`src/app/tools/tool-executor.ts`. Every caller goes through it, and it never throws:

```
lookup exact registered tool → validate input → policy → caller already cancelled?
  → deadline + execute → validate output → result size cap → one log event → Result
```

Only the executor calls `bindArguments`, so no code reaches a handler any other way
(`tests/architecture/tool-execution-path.test.ts`). The policy step fails closed today: a tool
that requires confirmation is refused with `confirmation_required`, because the host confirmation
channel arrives in M6.

### Outcomes

Every failure carries a stable `code` and a message that is safe to show a model or MCP client.

| Code | Handler invoked? | Effect on the world |
| --- | --- | --- |
| `unknown_tool`, `invalid_input`, `confirmation_required` | no | none |
| success | yes, finished | done |
| `execution_failed` | yes, finished | the tool's declared expected failure |
| `invalid_output`, `output_too_large` | yes, finished | effects done, result withheld |
| `timed_out`, `cancelled`, `internal_error` | maybe | unknown |

Callers must treat an unknown outcome as "may have executed". A `cancelled` call whose handler
never started is in fact effect-free, but it shares the conservative meaning so callers have one
rule; the log field `handlerInvoked` tells operators which it was.

`invalid_input` messages list each issue's path with Zod's message, at most ten. Zod's built-in
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
read-only tools and is why write tools need idempotency (M2).

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
before it is validated and measured. Argument size is bounded by the transport (M3, M5) and by
schema limits such as `maxLength`.

## Initial tools

| Tool | Risk | Proves | Milestone |
| --- | --- | --- | --- |
| `get_current_time` | read | `Clock` port, schema validation, OpenAI/MCP reuse | M1 |
| `calculate` | read | Operation enum + numeric inputs, no `eval`, declared failures | M1 |
| `create_note` | write | Side effects, generated ids, persistence port, idempotency | M2 |
| `read_note` | read | Not-found semantics, output schema, safe persistence access | M2 |
| `delete_note` | destructive | Confirmation policy and audit event — only after the policy exists | M6 (optional) |

## Adding a tool

1. Create `src/tools/<tool-name>/<tool-name>-tool.ts`.
2. Define strict input and output Zod schemas; describe every input property.
3. Define metadata (name, description, risk, timeout, confirmation) and the expected `failures`.
4. Implement `execute` against the tool context; return `ok(output)` or `err(reason)`.
5. Add the definition to the registry in `src/bootstrap/create-application.ts`.
6. Add unit tests through the executor (valid, invalid input, each failure reason; idempotency if
   it writes). `tests/contract/tool-registry.test.ts` checks the new tool automatically.
7. OpenAI and MCP expose it automatically once their adapters exist (M3, M5).
