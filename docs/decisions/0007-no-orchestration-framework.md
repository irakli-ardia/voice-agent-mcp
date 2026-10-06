# 0007 — No orchestration framework for the agent loop

Status: accepted — 2026-10-06

## Context

The project's value is the visible seam between model output and deterministic execution: limits,
validation, cancellation, error mapping. Frameworks such as LangChain hide that seam.

## Decision

The agent loop is first-party code on the official OpenAI SDK's Responses API: bounded iterations,
explicit tool-call handling through the executor, `AbortSignal` cancellation.

## Consequences

- Loop protection, retries, and conversation state are written and tested here.
- Fewer dependencies and no framework upgrade churn.
- Features such as memory or RAG are not available for free; they need a concrete requirement.

## Alternatives considered

- LangChain or similar — hides the loop and adds a large dependency; an explicit non-goal.
