# Tool system

The architectural centerpiece: a tool is defined once and every caller — the OpenAI agent loop and
the MCP server — derives from that definition and executes through one executor. Status: planned
(M1 registry and executor, M2 side-effect tools).

## Tool definition

Each tool exports one canonical definition from `src/tools/<tool-name>/` with:

| Field | Rule |
| --- | --- |
| `name` | Stable `snake_case`, unique across the registry |
| `description` | Precise enough for model selection: when to use it and when not to |
| `inputSchema` / `outputSchema` | Zod; reject unknown keys, bounded strings, enums for finite domains, described fields, no ambiguous optionals |
| `risk` | `read`, `write`, `destructive`, or `external` |
| `timeoutMs` | Per-tool execution budget |
| `requiresConfirmation` | Whether the host must obtain confirmation before execution |
| idempotency | Optional, for side-effecting tools ([security](security.md#idempotency)) |
| `execute(context, input)` | Receives validated input; returns output that is validated again |

Types are inferred from the schemas without unsafe casts. The handler's context holds only
explicitly permitted dependencies: turn id, child logger, abort signal, clock, note store, id
generator. Never the OpenAI client, never MCP or OpenAI types.

## Registry

- `src/app/tools/tool-registry.ts`: the set of definitions, looked up by exact name.
- Unknown names are rejected explicitly; no dynamic property traversal on a model-supplied string.
- From the registry, adapters derive OpenAI function-tool metadata, MCP tool registration, and
  the `tools` catalog. No hand-written OpenAI or MCP tool definitions exist anywhere.

## Executor pipeline

`src/app/tools/execute-tool.ts`. Every caller goes through it:

```
caller → lookup exact registered tool → validate raw input → policy check → confirmation gate
  → timeout + AbortSignal → execute → validate output → map expected error
  → structured audit/log event → canonical ToolExecutionResult
```

Invalid input never reaches a handler; invalid output never reaches a model or MCP client; the
result size is bounded before serialisation.

## Initial tools

| Tool | Risk | Proves | Milestone |
| --- | --- | --- | --- |
| `get_current_time` | read | `Clock` port, schema validation, OpenAI/MCP reuse | M1 |
| `calculate` | read | Operation enum + numeric inputs, no `eval`, deterministic tests | M1 |
| `create_note` | write | Side effects, generated ids, persistence port, idempotency | M2 |
| `read_note` | read | Not-found semantics, output schema, safe persistence access | M2 |
| `delete_note` | destructive | Confirmation policy and audit event — only after the policy exists | M6 (optional) |

## Adding a tool

1. Create `src/tools/<tool-name>/`.
2. Define input and output Zod schemas.
3. Define metadata (name, description, risk, timeout, confirmation).
4. Implement the handler against ports from the tool context.
5. Export one canonical definition and add it to the registry.
6. Add unit tests (valid, invalid input, failure, timeout; idempotency if it writes).
7. OpenAI and MCP expose it automatically; the catalog and contract tests pick it up.
