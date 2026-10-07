# Invariants

The project's 36 repository invariants, numbered, with where each is enforced.
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
| 6 | Every model-callable action exists in the canonical registry | `tests/contract/tool-registry.test.ts` (including the model-facing projection); MCP contract tests (planned, M5) |
| 7 | OpenAI and MCP never implement separate tool handlers | Contract test: both adapters derive from the same registry (planned, M5) |
| 8 | Every tool has input and output validation | `defineTool` types, executor validation, `tests/contract/tool-registry.test.ts` |
| 9 | Every tool has risk metadata | `ToolSpec` type (destructive requires confirmation), `tests/contract/tool-registry.test.ts` |
| 10 | Every tool execution passes through policy + timeout + logging | Single executor, `tests/architecture/tool-execution-path.test.ts`; agent runner tests (calls reach the real executor); MCP (planned, M5) |
| 11 | Destructive tools cannot self-confirm through the LLM | Executor policy fails closed until the host confirmation channel exists (M6); executor tests |
| 29 | Every write tool takes a required idempotency key; a repeated key never repeats the effect | `tests/contract/tool-registry.test.ts` (required, bounded key on every `write` tool); tool, store, and integration tests ([decision 0008](../decisions/0008-idempotent-note-creation.md)) |
| 30 | Host-owned fields never reach the model: a `key` tool's `idempotencyKey` is absent from its model-facing schema and is always derived by the host in the agent loop | `idempotency` metadata (`defineTool` type, registry startup check), `tests/contract/tool-registry.test.ts`, `tests/unit/app/agent/` (projection, derivation, runner) |
| 31 | No tool call runs from a model step that was not accepted: invalid or reused call ids, an exhausted iteration or tool-call budget, an incomplete, refused, or unsupported response | `tests/unit/app/agent/agent-runner.test.ts`, `tests/unit/adapters/openai/responses-agent-model.test.ts` |

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
| 21 | MCP stdio never logs to stdout | Logger defaults to stderr; MCP stdout-clean test (planned, M5) |
| 22 | Shutdown is graceful | Shutdown tests (planned, M6) |

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
