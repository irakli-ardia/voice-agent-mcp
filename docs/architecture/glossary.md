# Glossary

Terms that could be read more than one way, with the meaning this project uses. Code, docs, and
CLI output use these words consistently; a design discussion adds to this list when it settles a term.

| Term | Meaning here | Not to be confused with |
| --- | --- | --- |
| Turn | The agent part of one `ask`: one user text (typed, or the transcription of `--audio`), zero or more model and tool rounds, then exactly one final answer or one typed terminal error; identified by a host-generated `turnId`. No history survives between turns. Transcription and speech run outside the turn and its deadline | A whole conversation or session; the whole `ask` command |
| Agent iteration | One logical `AgentModel.respond` invocation inside a turn, including the one that returns the answer; `MAX_AGENT_ITERATIONS` is the maximum number per turn. Transport retries inside one invocation do not count | A turn; an HTTP attempt |
| Transcript | The runner's per-turn, append-only list of canonical items (`user_text`, `model_step`, `tool_result`), sent whole with every model request | Provider-side conversation state; a transcription (speech-to-text output) |
| Model step | One completed model response in canonical form: optional text, tool calls in response order, and a continuation | A provider response object |
| Continuation | The model adapter's opaque protocol state for one step (for OpenAI, the step's output items), carried to the next request unread, unlogged, and unpersisted | Anything the runner decides with |
| Accepted step | A model step that passed every runner check (call ids, iteration and tool-call budgets); only its calls may run | A step whose text is shown as the answer |
| Final answer | Non-blank text from a step with no tool calls | Text that arrived together with tool calls |
| Turn deadline | `AGENT_TURN_TIMEOUT_MS`: one wall-clock budget for a whole turn; when it passes, no further model call or tool starts | A tool's own `timeoutMs`; the per-attempt provider timeout |
| Host-owned field | A canonical tool input the host supplies and the model never sees: `idempotencyKey` on an `idempotency: "key"` tool | A field the model may fill in |
| Tool definition | The single canonical object `defineTool` returns: name, description, input and output Zod schemas, risk, timeout, confirmation flag, declared failures, and the handler bound through `bindArguments` | An OpenAI function definition or MCP tool entry (both are derived from it) |
| Tool registry | The set of tool definitions, looked up by exact name only | Dynamic property lookup on an object |
| Tool executor | The one pipeline every tool call passes: lookup → validate input → policy (confirmation) → timeout → execute → validate output → size cap → map errors → log | A tool handler |
| Tool call | A request from the model or an MCP client to run a named tool with raw (untrusted) arguments; identified by `toolCallId` | A tool execution that already passed validation |
| Failure reason | A tool's declared identifier for an expected failure (`division_by_zero`), mapped to a static, client-safe message | A thrown error or its message (those become `internal_error`) |
| Outcome unknown | The meaning of `timed_out`, `cancelled`, and `internal_error`: the executor stopped waiting, and the handler may or may not have completed its effect | Proof that nothing happened |
| Late settlement | A handler finishing after the executor already returned `cancelled` or `timed_out`; logged as `tool.settled_late`, never changing the caller's result | A retry |
| Abandoned handler | A handler the executor stopped waiting for (a deadline or a cancellation) that is still running; tracked by the handler ledger until it really settles, and capped by `MAX_ABANDONED_TOOL_HANDLERS` | A handler that was stopped (none can be) |
| Note slot | A directory `note-slots/<index>/` holding a hard link to a complete note file; one is claimed, exclusively, before a note is published, so there are never more notes than `MAX_NOTES`. The note's slot is the record that is the same file as the note | A copy of the note, or a lock |
| Risk level | `read`, `write`, `destructive`, or `external`; drives the policy decision | Log level |
| Confirmation | Explicit approval from the user or host, obtained outside the model | The model saying the user agreed |
| Confirmation grant | A `ConfirmationGrant`: host-issued, for one tool name and call id, spent when the handler is admitted; carried on the `ToolCall`, never in its arguments | A flag, a tool argument, or `_meta` |
| Host | The process presenting tools to a model: the CLI agent or an MCP client | The OpenAI or MCP SDK |
| Idempotency key | Required input of every write tool naming one logical operation; owned by the executor's caller — in the agent loop the host, which derives it from the turn, the tool, and the other arguments, never the model. Scope: the whole note store; it lives as long as its note | Exactly-once delivery (never claimed); a transport or tool-call id |
| Replay | A repeated `create_note` with a used key and the same text: returns the original note with `created: false` and writes nothing | A conflict (same key, different text) |
| Commit point | The single step after which a write is visible and a key is taken: for notes, the successful hard link of the fsynced file to the note's name (publication). The slot claim before it only reserves quota and keeps a durable record of intent | Writing the temp file, or claiming a slot |
| Transcription | The text speech-to-text returns for an `--audio` file; it becomes the turn's user text unchanged | The runner's transcript |
| Speech renderer | The Realtime model that speaks the final answer. It receives the answer as data and decides nothing: no tools, no conversation | An assistant or second agent |
| Spoken text | The renderer's own report of what it spoke, compared word for word with the answer before any audio is saved (the fidelity check) | An independent transcription of the audio |
| Speech deadline | `SPEECH_TIMEOUT_MS`: one wall-clock budget for one transcription or one rendering, including every attempt, retry wait, and byte received | The turn deadline; the per-attempt provider timeout |
| Reserved output | The `--speech-out` file, created exclusively before any provider is used and either committed (written, synced, closed) or removed | A file written at the end |
| MCP era | One of the two protocol generations the server speaks: modern (2026-07-28, no `initialize`, per-request metadata) or legacy (2025-11-25, `initialize` handshake); the server serves both | A tool or API version |
| Tool descriptor | The MCP form of a tool definition (name, description, input and output JSON Schema, annotation hints), projected from it once at startup | A second tool definition |
| In-flight limit | `MCP_MAX_IN_FLIGHT_CALLS`: how many MCP tool calls may be executing at once; the next is refused with `server_busy` before any handler runs | The rate limit; a limit on handlers still running after a cancellation or timeout |
| Rate limit | `MCP_MAX_CALLS_PER_SECOND`: a token bucket (rate = burst) on MCP `tools/call`; a call without a token gets `rate_limited` before any handler runs | A limit on what a client may send, or on `tools/list` |
| Port / adapter | Port: an interface the application owns (`src/ports`). Adapter: its implementation for a provider, protocol, or the OS (`src/adapters`) | A protocol adapter's business logic (there is none) |
| Note | A short, immutable text record (`id`, `text`, `createdAt`) created by `create_note` and read by `read_note`; one JSON file under `DATA_DIR/notes`, its id derived from its idempotency key | A file path chosen by the model |
| Dry run | Shows the proposed tool calls and policy decisions without performing side effects (planned with the confirmation policy, M6) | A test run with fakes |

## Maintenance

Add a term the first time two people (or an agent and a person) meant different things by it.
Rename in code when a term changes here; a glossary that disagrees with the code is worse than none.
