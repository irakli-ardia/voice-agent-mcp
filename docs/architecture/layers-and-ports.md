# Layers and ports

What each layer owns, how ports and adapters are shaped, and how the composition root wires them.
Read before adding a port, adapter, app service, or domain type. This project has no database and
no bounded-context modules: its areas are the tool system, the agent loop, the audio pipeline, and
the MCP server, and each tool folder under `src/tools/` is a self-contained unit.

Paths: domain `src/domain/`, ports `src/ports/`, app services `src/app/`, tools `src/tools/`,
adapters `src/adapters/`, composition root `src/bootstrap/create-application.ts`.

## Vocabulary

| Term | Here |
| --- | --- |
| Port | An interface the app owns for something it needs from outside (model, STT, TTS, clock, ids, logger, note store). |
| Adapter | An implementation of a port or a protocol translation (OpenAI, MCP, files, pino, system clock). |
| App service | An orchestrator in `src/app/` (agent runner, audio services, executor). Holds the flow, not provider details. |
| Tool definition | The canonical unit of behaviour; see [tool system](tool-system.md). |
| Composition root | The one function that knows concrete implementations. |

The ubiquitous language is [the glossary](glossary.md); names in code use its terms exactly.

## Domain

- `src/domain/` holds the error taxonomy and result types (M1): stable `code`, safe public message,
  internal `cause`, retryability. It imports nothing from other layers and no I/O module.
- Pure functions, no clock reads (take `now` as an argument), no logging.

## Ports

- Declared in `src/ports/<role>.ts`, one interface per file, named for the role
  (`SpeechToText`, `NoteStore`), never for a technology (`OpenAiStt`).
- A port lists only the methods a caller uses today. Add a method with the caller that needs it.
- Port signatures use canonical types and `AbortSignal`; never a provider SDK type.
- A port with one implementation exists only at an I/O boundary (provider, filesystem, clock, ids,
  logging). Do not create ports for in-process logic.
- No placeholder adapters for providers that are not implemented (plan §32): the abstraction is
  proven by the test fakes.

## Adapters

- Live in `src/adapters/<area>/`; the only code that imports provider SDKs, MCP, pino, or `fs`.
- Translate the provider's shapes and errors into canonical types and application errors
  (anti-corruption layer). A provider type never crosses into `src/app`, `src/tools`, or
  `src/domain`.
- Every adapter honours the whole port contract — the same errors, null semantics, and
  cancellation behaviour as every other implementation, including the test fake.

## App services

- Take their dependencies as explicit parameters (a factory that receives ports and returns the
  operation). No DI container, no service locator, no module-level singletons or hidden global
  mutable state.
- Input arrives already validated by the boundary that received it.

## Composition root

`src/bootstrap/create-application.ts` builds config-driven adapters and every service once per
process and hands them to the entrypoints. Entrypoints never construct an adapter or a tool.
Tests build services with fakes the same way. Shutdown ownership (`src/bootstrap/shutdown.ts`,
planned M3/M6) lives beside it.

## Adding a port and adapter

1. Confirm it is an I/O boundary a planned feature needs now.
2. Add `src/ports/<role>.ts` and a typed fake in `tests/helpers/`.
3. Write the caller and its tests against the fake.
4. Implement `src/adapters/<area>/<name>.ts` with error mapping and its tests.
5. Wire it in the composition root; run `npm run check:architecture` and `npm run fallow`.
