# 0003 — Zod at every untrusted boundary

Status: accepted — 2026-10-06

## Context

Model-generated tool arguments, MCP input, environment variables, persisted files, and provider
responses are all untrusted. TypeScript types alone do not check them at runtime.

## Decision

Zod v4 schemas validate every untrusted input and every tool output. Boundary types are inferred
from the schemas; no parallel interfaces. The same schema feeds OpenAI strict function schemas and
MCP tool schemas (via native helpers where possible; `zod-to-json-schema` only if required).

## Consequences

- One source of truth for shape and runtime checks.
- Schemas must stay within what OpenAI strict mode and MCP can express (no unknown keys, bounded
  strings, explicit optionality).
- Validation errors must be mapped to safe messages before reaching a model or client.

## Alternatives considered

- Hand-written type guards — fine for a few keys (allowed for small narrowing), unmanageable for
  tool schemas.
- A second schema system for OpenAI — duplication; an explicit non-goal.
