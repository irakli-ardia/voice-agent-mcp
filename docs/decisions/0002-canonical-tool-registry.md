# 0002 — One canonical, schema-driven tool registry shared by OpenAI and MCP

Status: accepted — 2026-10-06

## Context

The same actions must be callable by an OpenAI agent and by MCP clients. Two definitions per tool
would drift: different validation, different errors, different side-effect controls.

## Decision

Each tool is defined once (name, description, Zod input/output schemas, risk, timeout,
confirmation flag, handler) and registered in one registry. OpenAI function definitions, MCP tool
registration, and the tool catalog are derived from it, and every call runs through one executor.

## Consequences

- Validation, policy, timeouts, and logging are identical for every client.
- Adding a tool is one folder plus one registry entry; both protocols expose it automatically.
- Adapters must map from the canonical schema to each protocol's format; where a protocol cannot
  express a schema feature, the tool schema adapts, not the adapter.
- Contract tests must prove both adapters use the same registry.

## Alternatives considered

- Separate OpenAI and MCP tool definitions — duplication and drift; an explicit non-goal.
