# 0006 — Confirmation policy outside the model

Status: accepted — 2026-10-06

## Context

A model can be prompted, or can hallucinate, into requesting destructive actions and into claiming
the user agreed.

## Decision

Every tool carries risk metadata (`read`, `write`, `destructive`, `external`). The executor's policy
step decides; destructive tools require confirmation obtained by the host (CLI prompt or token)
outside the LLM. The model cannot confirm its own request. MCP keeps server-side risk metadata and
policy hooks even when the client has its own confirmation UX.

## Consequences

- The executor needs a confirmation gate and a way for hosts to supply confirmation.
- Dry-run can show policy decisions without side effects.
- `delete_note` waits until the policy exists (M6).

## Alternatives considered

- Asking the model to confirm with the user in conversation — the model is untrusted; rejected.
