# Architecture

How voice-agent-mcp is put together and the rules that keep it that way. Start here; each topic
file below holds the detailed, normative rules for one area.

## Shape

One npm package with two entrypoints: a CLI (`voice-agent`) and, from M5, an MCP stdio server.
Plain Node.js with explicit composition — no framework, DI container, decorators, or agent
orchestration library ([decision 0001](../decisions/0001-initial-stack.md)).

```
src/
  domain/        result, JSON value, tool error, and note types; imports nothing else
  ports/         interfaces the app owns: model, STT, TTS, clock, ids, logger, note store
  app/           agent runner, audio services, tool registry/executor/policy
  tools/         the definition contract, and one folder per canonical tool
  adapters/      openai, mcp, persistence, system, logging implementations
  config/        the only process.env reader; Zod-validated config
  bootstrap/     composition root
  entrypoints/   voice-agent.ts bin, cli.ts, mcp-stdio.ts: wiring and process I/O
tests/           unit, architecture, contract, integration, fixtures, helpers
```

## Layer rules

Dependencies point inward: entrypoints → bootstrap → adapters → app → tools/ports → domain.

- **Domain** (`src/domain`) — error taxonomy, result types, and the note type and its id and key
  formats. Imports nothing from other layers and no provider, protocol, or I/O module.
- **Ports** (`src/ports`) — interfaces named for their role. Types only; no provider types.
- **App** (`src/app`) — agent runner, audio services, registry, executor, policy. Depends on ports,
  tools, and domain; never on OpenAI, MCP, pino, `fs`, `process`, config, or adapters.
- **Tools** (`src/tools`) — canonical definitions: Zod schemas, metadata, and a handler written
  against the tool context (ports only). No OpenAI or MCP types.
- **Adapters** (`src/adapters`) — implement ports and translate protocols. The only place provider
  SDKs and I/O modules are imported; provider errors are translated before they leave. No
  business logic.
- **Config** (`src/config`) — parses and validates the environment once; the only `process.env`
  reader.
- **Bootstrap** (`src/bootstrap`) — the composition root: chooses concrete adapters and wires
  them to ports. No service locator, no container.
- **Entrypoints** (`src/entrypoints`) — parse arguments, call bootstrap, write output, set exit
  codes, own signal handling. No business logic; never import adapters or tools directly.

Enforced by `tests/architecture/dependency-direction.test.ts`, fallow boundary zones
(`.fallowrc.json`), and Biome `noRestrictedImports` overrides (`biome.json`).

## Request path

```
entrypoint (CLI or MCP stdio) → composition root → app service (agent runner)
  → tool executor → tool handler → port → adapter
```

- **Entrypoint** — `src/entrypoints/cli.ts` (`ask`, `tools`; `doctor` in M6) or `mcp-stdio.ts`
  (M5): parses and validates input, owns the root `AbortController` (aborted on the first SIGINT),
  maps outcomes to exit codes or protocol responses.
- **Speech stages** (M4) — for `ask --audio` and `--speech-out`, the CLI runs the transcription
  service before the turn and the speech output service after it
  ([audio pipeline](audio-pipeline.md)); the turn itself is unchanged.
- **Composition root** — `src/bootstrap/create-application.ts` builds the canonical tools and
  executor once per process; `src/bootstrap/create-agent.ts` adds the OpenAI-backed agent only for
  a command that calls the model, after it has loaded its credentials
  (`src/bootstrap/composition.ts` holds both, and tests pass their own).
- **App service** — `src/app/agent/agent-runner.ts`: runs the bounded model loop through the
  `AgentModel` port ([agent loop](agent-loop.md)). The MCP path skips this hop and goes straight to
  the executor.
- **Tool executor** — `src/app/tools/tool-executor.ts`: the one pipeline every call passes.
- **Tool handler** — `src/tools/<tool-name>/`: receives validated input and a narrow tool context.
- **Port → adapter** — what the handler or service needs (clock, ids, note store, model, STT, TTS,
  logger), implemented in `src/adapters/` and chosen only in bootstrap.

Exceptions to these rules are inline `fallow-ignore-next-line` / `biome-ignore` comments with a
reason; there are none.

## Runtime and configuration

- No hosted environment: the CLI runs on a developer machine, and the MCP server is spawned over
  stdio by an MCP host (Claude, the MCP Inspector). CI runs on Node 22 and 24 with fakes only —
  no API key, no provider network calls.
- `src/config/config.ts` validates every non-secret variable at startup, for every command;
  invalid configuration exits with code 78 and names the variable, never its value.
  `OPENAI_API_KEY` is the exception: `src/config/openai-credentials.ts` reads it only for `ask`, so
  `--help` and `tools` work without it, and `ask` exits 78 when it is missing. `.env.example` lists
  every variable.
- Runtime data (notes) lives under the application-owned `DATA_DIR`
  (`.data/` by default, git-ignored), resolved to an absolute path against the working directory
  at startup. Audio is never stored there: `--audio` reads and `--speech-out` creates only files
  the CLI user names ([audio pipeline](audio-pipeline.md)). It must be on a local filesystem with hard links
  ([filesystem safety](security.md#filesystem-safety)); a host that spawns the process from an
  unknown working directory (an MCP host, M5) should set it to an absolute path.

## Scope

Not built, on purpose: a frontend, a database (unless a tool needs one), authentication on the
local stdio transport, queues, microservices, a second tool-definition system for MCP, a second
validation schema for OpenAI, and placeholder adapters for providers that are not implemented.

## Topics

| Read | Before changing |
| --- | --- |
| [Layers and ports](layers-and-ports.md) | A port, adapter, app service, or domain type |
| [Tool system](tool-system.md) | A tool, the registry, the executor, risk metadata, tool results |
| [Agent loop](agent-loop.md) | The Responses API loop, model calls, provider rules |
| [Audio pipeline](audio-pipeline.md) | Speech-to-text, text-to-speech, audio limits or output |
| [MCP](mcp.md) | The MCP server, its registration, stdio handling |
| [Security](security.md) | Risk policy, confirmation, limits, filesystem access, secrets, retries |
| [Observability](observability.md) | Log events, correlation fields, timings |
| [Invariants](invariants.md) | Anything — the 36 repository invariants and where each is enforced |
| [Glossary](glossary.md) | Naming — the terms code and docs use exactly |

Why the big choices were made: [decisions](../decisions/README.md).
