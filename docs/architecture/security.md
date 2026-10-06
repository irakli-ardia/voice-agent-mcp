# Security

Trust boundaries, action policy, and limits. The full threat model is `docs/threat-model.md`
(M6).

## The model is untrusted input

Never trust tool arguments because OpenAI returned them; never invoke a property or function named
by a model-supplied string; never let the model choose filesystem paths; never expose environment
variables; never run model-supplied shell commands; never deserialise unknown JSON into trusted
types; never leak internal errors or secrets into model context. MCP client input gets the same
treatment.

## Action policy

| Risk | Policy |
| --- | --- |
| `read` | Execute normally |
| `write` | May execute when user intent is explicit |
| `destructive` | Requires confirmation |
| `external` | Depends on irreversible effects; decided per tool |

Confirmation is obtained outside the LLM — for the CLI, an explicit user prompt or token handled by
the host. The model cannot confirm its own destructive request. Until the host confirmation
channel exists (M6), the executor fails closed: every tool that requires confirmation is refused
with `confirmation_required`.

## Idempotency

`create_note` accepts an optional caller-provided idempotency key, or the host derives a scoped
operation key, so provider/network retries do not duplicate the effect. A `timed_out` or
`cancelled` result does not mean the handler stopped: its outcome is unknown, so a retry after
either must be safe to repeat ([tool system](tool-system.md#timeouts-and-cancellation)).
Scope and expiry are defined in M2 (open question) and tested with duplicate calls. Never claim exactly-once; document
the at-least-once reality.

## Filesystem safety (file-backed notes)

Application-owned root directory (`DATA_DIR`); generated ids, never model-chosen filenames; no
absolute paths from users or the model; resolved-path containment check; restrictive permissions
where practical; atomic writes; persisted data validated on read; corruption handled explicitly.

## Denial and cost controls

Input limits, audio size limit, TTS text limit, agent-loop limit, tool-call limit, timeouts, a
concurrency bound if needed, no unlimited retries. `MAX_TOOL_RESULT_BYTES` caps the serialised
result that leaves the tool executor; it does not limit a handler's memory or CPU
([tool system](tool-system.md#result-size-cap)).

## Secrets and logging privacy

API keys never in logs, docs, or committed files (`.env` is git-ignored; `.env.example` holds
placeholders only). Provider error bodies are mapped, not forwarded. Raw audio and secrets are
never logged; transcript and payload logging is off or redacted by default (configurable,
M3/M6). The logger redacts known secret fields today (`src/adapters/logging/pino-logger.ts`).

## Dependency security

Committed lockfile, Dependabot, CodeQL (M6), `npm audit` as an informative check, minimal
dependency count, no abandoned convenience packages without justification.
