# 0005 — Ports and adapters for AI and audio providers

Status: accepted — 2026-10-06

## Context

Provider SDKs change quickly, and tests must run without network access or paid APIs. The
provider SDK must not become the architecture.

## Decision

The app owns ports for the agent model, speech-to-text, and text-to-speech (plus clock, ids,
logger, note store). OpenAI adapters implement them in `src/adapters/openai/`; provider types and
errors never leave that folder. Only OpenAI is implemented; no placeholder adapters.

## Consequences

- App, tool, and domain tests use typed fakes and never import `openai`.
- Adapters carry the error mapping and response normalisation burden.
- The abstraction is proven by the fakes, not by speculative second providers.

## Alternatives considered

- Calling the SDK directly from the agent runner — couples tests and logic to the provider.
- Multi-provider abstractions now — speculative generality; an explicit non-goal.
