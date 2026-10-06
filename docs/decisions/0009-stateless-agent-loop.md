# 0009 — Stateless agent loop: application-owned transcript, opaque continuation

Status: accepted — 2026-10-06

## Context

A turn is one `ask`: user text in, one answer or one typed error out, with any number of model and
tool rounds between. The OpenAI Responses API can keep that state on the server
(`previous_response_id`, conversations) or let the caller send the whole history each time. Server
state means storing responses (`store: true`, kept for at least 30 days), testing against state we
cannot see, and an `AgentModel` port shaped around one provider. Sending history ourselves is not
just text and tool calls: reasoning models need their reasoning items (with
`reasoning.encrypted_content` when nothing is stored), and assistant messages carry a `phase` that
should be sent back unchanged.

## Decision

- **Stateless requests.** Every request carries the whole turn: `store: false`,
  `truncation: "disabled"`, `include: ["reasoning.encrypted_content"]`. No `previous_response_id`,
  conversation, background mode, or compaction, and no fallback to server state.
- **The runner owns the transcript.** It holds only provider-independent data — user text, model
  text, tool calls, tool results, counters, the turn id — and decides everything from it.
- **The adapter owns an opaque continuation.** Each model step carries the provider items needed to
  continue (for OpenAI: the step's reasoning, message, and function-call items, replayed verbatim).
  The runner carries it to the next request and never reads, changes, logs, or persists it. The
  `AgentModel` port is generic in the continuation type, closed inside the runner factory, so no
  provider type crosses the port and no cast is needed.
- **Supported output only.** The adapter accepts assistant messages, direct function calls, and
  reasoning items from a `completed` response. Anything else — an incomplete response, a refusal,
  an unknown item, an asynchronous or programmatic call — is a typed failure, and none of its calls
  run.
- **Sequential calls.** The calls of one response run one at a time in response order; a failed
  call does not stop later ones; results are recorded in call order.
- **Host-owned idempotency.** A tool declares `idempotency: "key"` when its input takes the
  canonical `idempotencyKey`. The model-facing schema is projected from the canonical schema with
  that field omitted, and the runner derives the key as
  `base64url(SHA-256(turnId ‖ 0x00 ‖ toolName ‖ 0x00 ‖ canonicalJson(other arguments)))`.
- **Bounded turns.** `MAX_AGENT_ITERATIONS`, `MAX_TOOL_CALLS_PER_TURN` (checked per response before
  any call runs), and one wall-clock `AGENT_TURN_TIMEOUT_MS`. Caller cancellation wins over the
  deadline when both apply. Transient provider failures are retried inside one model invocation by
  a bounded policy; the SDK's own retries are off.
- **No dry run yet.** `ask --dry-run` waits for the confirmation policy (M6): with no destructive
  tools and confirmation failing closed, a dry run would either stop after one model step or invent
  tool results.

## Consequences

- `store: false` means the application does not store response state for later retrieval. It is
  not, by itself, zero data retention at the provider.
- Every request resends the turn, so input grows with each round; the iteration and tool-call
  limits and the result-size cap bound it, and prompt caching reuses the stable prefix.
- Tests are deterministic: a fake model receives the full transcript, and the adapter is tested as
  a function from transcript to request body.
- A process restart loses the turn, and nothing about it remains on the provider side for later
  retrieval. There is no resumption.
- Retrying a model request never runs a local tool: tools run only after one accepted step.

## Alternatives considered

- `previous_response_id` — needs stored responses and server state the tests cannot see; no billing
  benefit, since earlier input in the chain is billed again.
- Rebuilding requests from canonical text and calls only — drops reasoning items and `phase`.
- Conversation objects — durable server-side history across sessions; the wrong lifetime for one
  turn.
- Concurrent tool calls — nondeterministic ordering and logs, and every call's outcome unknown on
  cancellation, for no gain with fast local tools.
