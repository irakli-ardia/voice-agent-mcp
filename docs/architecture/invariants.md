# Invariants

The project's 28 repository invariants, numbered, with where each is enforced.
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
| 6 | Every model-callable action exists in the canonical registry | Contract tests (planned, M1/M3/M5) |
| 7 | OpenAI and MCP never implement separate tool handlers | Contract test: both adapters derive from the same registry (planned, M5) |
| 8 | Every tool has input and output validation | Contract test over the registry (planned, M1) |
| 9 | Every tool has risk metadata | Tool definition type + contract test (planned, M1) |
| 10 | Every tool execution passes through policy + timeout + logging | Single executor; adapters tested to call it (planned, M1/M3/M5) |
| 11 | Destructive tools cannot self-confirm through the LLM | Confirmation gate in the executor + tests (planned, M6) |

## Architecture invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 12 | Application/domain cannot import provider SDKs | `tests/architecture/dependency-direction.test.ts`, fallow zones, Biome overrides |
| 13 | Entrypoints contain composition and I/O wiring, not business logic | Architecture test (no adapter/tool imports), Biome override; review |
| 14 | Only the config module reads environment variables | Biome `noProcessEnv` (off only in `src/config`), architecture test |
| 15 | Only persistence adapters touch storage implementation details | Architecture test bans `fs` in core layers; review (planned tests, M2) |
| 16 | Provider errors are translated before crossing adapter boundaries | Adapter error-mapping tests (planned, M3–M4) |

## Operational invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 17 | Every external call has a timeout/cancellation strategy | Ports take `AbortSignal`; adapter tests (planned, M3–M4) |
| 18 | Agent loop is bounded | Max-iteration test (planned, M3) |
| 19 | Tool-result size is bounded | Executor test (planned, M1/M3) |
| 20 | Logs are structured and secret-safe | pino adapter with redaction + `tests/unit/adapters/logging/pino-logger.test.ts` |
| 21 | MCP stdio never logs to stdout | Logger defaults to stderr; MCP stdout-clean test (planned, M5) |
| 22 | Shutdown is graceful | Shutdown tests (planned, M6) |

## Process invariants

| # | Rule | Enforced by |
| --- | --- | --- |
| 23 | CI must pass before merge | `.github/workflows/ci.yml`, merge gate, required checks |
| 24 | Architecture/docs change with behaviour when relevant | docs-check, PR template, code review |
| 25 | No disabled test without explicit reason | Review; [testing](../testing.md) |
| 26 | No `.only` committed | Vitest `allowOnly: false` |
| 27 | No secret or `.env` committed | `.gitignore`, review, GitHub secret scanning |
| 28 | New tools require tests and registry documentation | Contract tests + [tool system](tool-system.md) checklist |
