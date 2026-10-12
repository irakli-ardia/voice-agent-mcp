# Invariants

The project's 46 repository invariants, numbered, with where each is enforced.
This file is the complete list.
"Planned" names the milestone that adds the enforcement.

## Type invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 1 | No first-party `any` | Biome `noExplicitAny`, `tests/architecture/forbidden-type-escapes.test.ts` |
| 2 | No unsafe type assertions | oxlint anti-slop, forbidden-type-escapes test, [TypeScript rules](../coding-standards.md#typescript) exception process |
| 3 | Unknown external data is validated before use | Zod at boundaries (`src/config/config.ts` today); review |
| 4 | Runtime schema is the source of truth for boundary types | `z.infer`/`z.output` types only; review |
| 5 | Exported APIs have deliberate types | Explicit return types on exported functions; review |

## Tool invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 6 | Every model-callable action exists in the canonical registry | `tests/contract/tool-registry.test.ts` (including the model-facing projection); `tests/unit/adapters/mcp/mcp-tool-descriptors.test.ts` (the MCP descriptors, one per registered tool, in order) |
| 7 | OpenAI and MCP never implement separate tool handlers | Both adapters derive from the one registry; architecture tests: the MCP adapter builds no executor, imports no tool, and is independent of the OpenAI adapter (`tests/architecture/dependency-direction.test.ts`) |
| 8 | Every tool has input and output validation | `defineTool` types, executor validation, `tests/contract/tool-registry.test.ts` |
| 9 | Every tool has risk metadata | `ToolSpec` type (destructive requires confirmation), `tests/contract/tool-registry.test.ts` |
| 10 | Every tool execution passes through policy + timeout + logging | Single executor, `tests/architecture/tool-execution-path.test.ts`; agent runner tests (calls reach the real executor); `tests/integration/mcp-server*.test.ts` (MCP calls reach the real executor under an `mcp:` call id) |
| 11 | Destructive tools cannot self-confirm through the LLM | The executor runs a tool that requires confirmation only with a `ConfirmationGrant` that trusted host code made for that tool and call; nothing from a model or an MCP client can carry one (`tests/unit/app/tools/tool-executor-confirmation.test.ts`, `tests/integration/mcp-confirmation.test.ts`, `agent-confirmation.test.ts`, `tests/e2e/mcp-dist/mcp-dist-confirmation.test.ts`) ([security](security.md#confirmation), [decision 0014](../decisions/0014-confirmation-grant.md)) |
| 29 | Every write tool takes a required idempotency key; a repeated key never repeats the effect | `tests/contract/tool-registry.test.ts` (required, bounded key on every `write` tool); tool, store, and integration tests ([decision 0008](../decisions/0008-idempotent-note-creation.md)) |
| 30 | Host-owned fields never reach the model: a `key` tool's `idempotencyKey` is absent from its model-facing schema and is always derived by the host in the agent loop | `idempotency` metadata (`defineTool` type, registry startup check), `tests/contract/tool-registry.test.ts`, `tests/unit/app/agent/` (projection, derivation, runner) |
| 31 | No tool call runs from a model step that was not accepted: invalid or reused call ids, an exhausted iteration or tool-call budget, an incomplete, refused, or unsupported response | `tests/unit/app/agent/agent-runner.test.ts`, `tests/unit/adapters/openai/responses-agent-model.test.ts` |
| 37 | The MCP server exposes exactly the registry's tools, with their canonical schemas and the required `idempotencyKey`, and never generates, derives, or rewrites a key | `tests/unit/adapters/mcp/mcp-tool-descriptors.test.ts`, `tests/integration/mcp-idempotency.test.ts`, `tests/integration/mcp-server.test.ts` ([decision 0011](../decisions/0011-mcp-server-on-the-low-level-sdk-api.md)) |

## Architecture invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 12 | Application/domain cannot import provider SDKs | `tests/architecture/dependency-direction.test.ts`, fallow zones, Biome overrides |
| 13 | Entrypoints contain composition and I/O wiring, not business logic | Architecture test (no adapter/tool imports), Biome override; review |
| 14 | Only the config module reads environment variables | Biome `noProcessEnv` (off only in `src/config`), architecture test |
| 15 | Only persistence adapters touch storage implementation details (notes, audio files) | `tests/architecture/dependency-direction.test.ts` (filesystem modules only under `src/adapters/persistence/`); review |
| 16 | Provider errors are translated before crossing adapter boundaries | OpenAI adapter error-mapping tests: Responses, speech-to-text, and the Realtime renderer classify by status, type, and code only, never message text |
| 32 | The agent loop keeps no provider-side state: stateless requests (`store: false`), no `previous_response_id` or conversation, and the provider continuation is opaque to the app | Responses adapter request tests, `AgentModel` port types, [decision 0009](../decisions/0009-stateless-agent-loop.md) |

## Operational invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 17 | Every external call has a timeout/cancellation strategy | Ports take `AbortSignal`; OpenAI per-attempt timeout and abortable retries (adapter tests); a speech deadline per transcription and rendering (`SPEECH_TIMEOUT_MS`, app tests); cancellation in every renderer state (loopback WebSocket tests) |
| 18 | Agent loop is bounded | Iteration, tool-call, and turn-deadline tests in `tests/unit/app/agent/agent-runner.test.ts` |
| 19 | The serialised tool result leaving the executor is bounded (not handler memory) | `MAX_TOOL_RESULT_BYTES`, executor tests |
| 33 | Every tool error message is at most 1024 bytes as serialised JSON, so a tool-result envelope has an exact maximum size | Executor `invalid_input` cap, registry startup check, executor, registry, and adapter envelope tests |
| 20 | Logs are structured and secret-safe | pino adapter with redaction + `tests/unit/adapters/logging/pino-logger.test.ts` |
| 21 | MCP stdio never writes anything but protocol messages to stdout | Logger writes to stderr; no `console` in `src` and process streams only in the bin (architecture test); every stdout line of the real server, source and built, is parsed as JSON-RPC (`tests/integration/mcp-stdio-*.test.ts`, `tests/e2e/mcp-dist/`) |
| 42 | Abandoned tool handlers are bounded: every invoked handler is tracked until its own promise settles, and once `MAX_ABANDONED_TOOL_HANDLERS` are abandoned a new call is refused with `overloaded` before any handler runs | `tests/unit/app/tools/handler-ledger.test.ts`, `tool-executor-ledger.test.ts`, `tests/integration/mcp-handler-ledger.test.ts`, `agent-handler-ledger.test.ts` ([tool system](tool-system.md#unsettled-handlers)) |
| 43 | MCP `tools/call` is rate limited: a call without a token (default 20 per second, burst 20, one bucket per process) is refused with `rate_limited` before any handler runs; a call that finds a token keeps it even when the in-flight cap refuses it | `tests/unit/adapters/mcp/call-admission.test.ts`, `tests/integration/mcp-rate-limit.test.ts` ([MCP](mcp.md#rate-limit)) |
| 44 | A client that stops reading stdout cannot grow the server's memory without limit: at 64 KiB of queued output the server stops reading requests (a threshold; the answers to the read that crossed it are still queued), the queue has an enforced maximum (33 MiB by default) past which the connection fails with exit 1, and every line written is a whole JSON-RPC message | `tests/unit/bootstrap/flow-controlled-output.test.ts`, `serve-mcp-backpressure.test.ts`, `serve-mcp-output-limit.test.ts`, real processes in `tests/integration/mcp-stdio-backpressure.test.ts` and `tests/e2e/mcp-dist/mcp-dist-backpressure.test.ts` ([MCP](mcp.md#stdio-and-the-process)) |
| 45 | The note store never holds more than `MAX_NOTES` notes, across concurrent calls and processes, with no lock; a replay of a saved key always succeeds, even when the store is full; and recovery from a crash at any step never frees a slot that backs a note | `tests/unit/adapters/persistence/note-quota.test.ts`, `note-slot-layout.test.ts`, real processes in `tests/integration/note-store-processes.test.ts`, `tests/e2e/mcp-dist/mcp-dist-quota.test.ts` ([security](security.md#note-quota), [decision 0013](../decisions/0013-note-quota-slots.md)) |
| 46 | `voice-agent mcp` writes only where `DATA_DIR` says: it exits 78 unless `DATA_DIR` is explicitly set to an absolute path, creates nothing before that check, and never prints the rejected value | `tests/unit/config/config-data-dir-policy.test.ts`, `tests/unit/entrypoints/mcp-stdio.test.ts`, real processes in `tests/integration/mcp-data-dir-policy.test.ts` and `tests/e2e/mcp-dist/mcp-dist-data-dir-policy.test.ts` ([MCP](mcp.md#data_dir), [decision 0015](../decisions/0015-mcp-requires-explicit-data-dir.md)) |
| 22 | Shutdown is graceful and bounded | MCP: stdin EOF and SIGINT/SIGTERM close admission and the connection, abort in-flight calls, release stdin, wait for handlers and queued answers for at most 2 seconds, and the bin ends the process shortly after if anything still holds it, with the exit code the graceful path would have used (`tests/unit/bootstrap/serve-mcp-shutdown.test.ts`, `tests/unit/entrypoints/mcp-stdio.test.ts`, real processes in `tests/integration/mcp-stdio-shutdown.test.ts`, `tests/e2e/mcp-dist/mcp-dist-shutdown.test.ts`) ([MCP](mcp.md#shutdown)) |
| 38 | Concurrent MCP calls are bounded: past `MCP_MAX_IN_FLIGHT_CALLS` a call is refused with `server_busy` before any handler runs, and every slot is released however a call ends | `tests/unit/adapters/mcp/create-mcp-server.test.ts`, `tests/integration/mcp-server-concurrency.test.ts`, `mcp-resource-bounds.test.ts`; the cap does not count handlers that outlive a cancellation or timeout (invariant 42) ([MCP](mcp.md#concurrency-and-limits)) |
| 39 | An inbound MCP message is at most 1 MiB; an oversized one ends the process with exit 1, never 0, and never hangs it | `tests/unit/bootstrap/serve-mcp.test.ts`, `tests/integration/mcp-stdio-process.test.ts`, `tests/e2e/mcp-dist/` |
| 40 | A thrown value never reaches a log or a response: only a class from a fixed allowlist is logged | `tests/unit/app/tools/tool-executor-log-privacy.test.ts` (real pino, hostile errors), `tests/integration/mcp-privacy.test.ts` ([decision 0012](../decisions/0012-thrown-values-are-never-logged.md)) |

## Speech invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 34 | Audio enters only from a file the CLI user names; the only file written is the explicitly named output, created exclusively, never overwritten, and removed unless committed | `tests/unit/entrypoints/cli-arguments.test.ts`, `tests/unit/adapters/persistence/local-audio-files.test.ts`, `tests/integration/voice-ask.test.ts`, `tests/unit/app/audio/speech-output.test.ts` |
| 35 | Audio bytes, file paths, transcriptions, and spoken text never reach stdout, stderr, or logs; stdout carries only the answer | Privacy tests in `tests/unit/entrypoints/cli-speech.test.ts`, the speech services, and the speech adapters |
| 36 | The speech renderer never decides content: no tools, no conversation, the answer sent only as data, and audio saved only when the spoken text matches the answer word for word | `tests/unit/adapters/openai/realtime-text-to-speech.test.ts` (exact request, event integrity), `tests/unit/app/audio/spoken-text-matches.test.ts`, `tests/unit/app/audio/speech-output.test.ts` |

## Process invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 23 | CI must pass before merge | `.github/workflows/ci.yml`, merge gate, required checks |
| 24 | Architecture/docs change with behaviour when relevant | docs-check, PR template, code review |
| 25 | No disabled test without explicit reason | Review; [testing](../testing.md) |
| 26 | No `.only` committed | Vitest `allowOnly: false` |
| 27 | No secret or `.env` committed | `.gitignore`, review, GitHub secret scanning |
| 28 | New tools require tests and registry documentation | Contract tests + [tool system](tool-system.md) checklist |
| 41 | The built MCP server is exercised by real child processes in every CI job, not only the TypeScript sources | `npm run test:mcp-dist` (`tests/e2e/mcp-dist/`), `.github/workflows/ci.yml` |
