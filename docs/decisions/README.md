# Decisions

One short record per hard-to-reverse choice: `NNNN-<kebab-title>.md`, numbered in order. A record
is never edited to change its outcome; a later record supersedes it and both link each other.

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-initial-stack.md) | Initial stack and repository shape (plain Node.js, explicit composition) | accepted |
| [0002](0002-canonical-tool-registry.md) | One canonical tool registry shared by OpenAI and MCP | accepted |
| [0003](0003-zod-at-untrusted-boundaries.md) | Zod at every untrusted boundary | accepted |
| [0004](0004-stdio-mcp-transport.md) | stdio MCP transport for v1 | accepted |
| [0005](0005-ports-and-adapters-for-providers.md) | Ports and adapters for AI and audio providers | accepted |
| [0006](0006-confirmation-outside-the-model.md) | Confirmation policy outside the model | accepted |
| [0007](0007-no-orchestration-framework.md) | No orchestration framework for the agent loop | accepted |
| [0008](0008-idempotent-note-creation.md) | Idempotent note creation: required key, key-derived id, hard-link publication | accepted |

## Template

```markdown
# NNNN — <Decision title>

Status: proposed | accepted | superseded by [NNNN](NNNN-….md) — YYYY-MM-DD

## Context

<The forces at play, in a few sentences.>

## Decision

<What we chose.>

## Consequences

<What becomes easier, what becomes harder, what we must now keep true.>

## Alternatives considered

- <option> — <why not>
```
