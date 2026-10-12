# 0014 — Confirmation is a host-issued, single-use grant on the call

Status: accepted — 2026-10-12

## Context

A tool can declare `requiresConfirmation`, and the executor refused every such call because no way to
confirm existed. A way is needed that a model or an MCP client can never use to approve its own
request, that works for the two-request shape of MCP elicitation as well as for a blocking prompt, and
that adds no state to the executor.

## Decision

The `ToolCall` carries an optional `confirmation: ConfirmationGrant`. A grant is a class instance with
private state, made by trusted host code for one tool name and call id, and the executor accepts only
an `instanceof` instance that covers the call and is unspent. It spends the grant when it admits the
handler, after validation, the cancellation check, and the handler ledger.

- Policy stays where it was: in the tool definition, set by trusted code. Arguments cannot change it.
- A model's output and an MCP request are data: the agent runner and the MCP adapter build calls from
  `id`, `name` and `arguments` only, and an instance cannot be made from text or JSON.
- Refusals are one static `confirmation_required`; the log records only `missing` or `rejected`.
- No production host issues grants yet, so a tool that requires confirmation is always refused there.

## Consequences

- Existing tools are unchanged; the gate costs one property check for a tool that does not use it.
- A later CLI prompt or MCP elicitation adapter is small: ask, then build the call with a grant.
- A grant proves a host said yes, not that a person did.
- A spent grant is not refunded by a timeout: the outcome of that call is unknown, so a retry asks
  again.

## Alternatives considered

- A blocking `ConfirmationChannel` port the executor awaits: cannot express MCP's two-request flow.
- A plain `confirmation: "granted"` field: any code, and any parser that copies fields, can set it.
- A signed token or per-process secret: more machinery for in-process trust that an instance check
  already gives.
- An allow-list or cache of approved call ids in the executor: ambient state that outlives the call.
