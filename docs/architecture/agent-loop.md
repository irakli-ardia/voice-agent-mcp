# Agent loop

The bounded OpenAI Responses API loop that turns a transcript into tool calls and a final answer,
and the rules for every model call. Status: planned (M3). Audio is in
[audio pipeline](audio-pipeline.md).

## Provider rules

- OpenAI is the only provider. Its code lives only in `src/adapters/openai/`; the app reaches it
  through the `AgentModel`, `SpeechToText`, and `TextToSpeech` ports and never imports `openai`.
  No placeholder adapters for other providers ([decision 0005](../decisions/0005-ports-and-adapters-for-providers.md)).
- Function-call arguments are the only structured model output, and the executor validates them
  with the tool's Zod input schema. Free-form model text is never parsed by hand.
- Model output is untrusted: it never supplies file paths, environment values, or confirmation
  ([security](security.md)).
- Budgets (iterations, tool calls, result size, audio size, TTS text, provider timeouts) come from
  config and are enforced centrally in the agent runner and executor. A tool's own execution
  budget is its `timeoutMs` ([tool system](tool-system.md#timeouts-and-cancellation)).
- Model and voice names are configuration, never hard-coded.
- Each model call is logged with provider, model, latency, attempt, and outcome — never secrets,
  prompts, or transcripts by default ([observability](observability.md)).

## Behaviour

1. Build function definitions from the canonical registry; strict schemas where supported.
2. Submit the user text plus the available tools through the `AgentModel` port.
3. Parse response output with the official SDK types inside `src/adapters/openai/` only.
4. Support zero, one, or several function calls per response.
5. Execute each through the canonical executor; associate each result with its call id.
6. Continue the loop with the tool outputs; stop on a final assistant response.
7. Enforce the limits below; cancel through `AbortSignal`; apply the provider timeout.
8. Map provider errors to application error categories; never expose secrets or stack traces to
   the model.

Before writing the adapter, read the installed `openai` package's current docs and types: use the
Responses API, not legacy Chat Completions patterns, and keep model names in config.

## Loop protection

Hard limits, all from config: maximum agent iterations, maximum tool calls per turn, maximum
serialised tool-result size, provider timeout. Tool budgets come from each definition's
`timeoutMs`, not config; a turn deadline, if needed, reaches the executor as the caller's
`AbortSignal`. A runaway model loop terminates predictably with a typed error.

## Conversation state (v1)

One turn in memory, an explicit conversation representation, no hidden global mutable state, no
unbounded history. No vector database or RAG without a concrete retrieval requirement.

## Retries

Bounded, exponential backoff with jitter, cancellation-aware, in one reusable policy — only for
transient provider/network failures on operations safe to retry. Never for validation or
authentication failures, destructive actions, or non-idempotent tool executions.

## Dry run

`ask --dry-run` shows the proposed tool calls and policy decisions without performing side
effects (M3/M6).
