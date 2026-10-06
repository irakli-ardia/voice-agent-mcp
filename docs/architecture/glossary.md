# Glossary

Terms that could be read more than one way, with the meaning this project uses. Code, docs, and
CLI output use these words consistently; a design discussion adds to this list when it settles a term.

| Term | Meaning here | Not to be confused with |
| --- | --- | --- |
| Turn | One user request (text or audio) processed to a final answer and optional speech; identified by `turnId` | A whole conversation or session |
| Agent iteration | One model request/response round inside a turn; capped by `MAX_AGENT_ITERATIONS` | A turn |
| Tool definition | The single canonical object `defineTool` returns: name, description, input and output Zod schemas, risk, timeout, confirmation flag, declared failures, and the handler bound through `bindArguments` | An OpenAI function definition or MCP tool entry (both are derived from it) |
| Tool registry | The set of tool definitions, looked up by exact name only | Dynamic property lookup on an object |
| Tool executor | The one pipeline every tool call passes: lookup → validate input → policy (confirmation) → timeout → execute → validate output → size cap → map errors → log | A tool handler |
| Tool call | A request from the model or an MCP client to run a named tool with raw (untrusted) arguments; identified by `toolCallId` | A tool execution that already passed validation |
| Failure reason | A tool's declared identifier for an expected failure (`division_by_zero`), mapped to a static, client-safe message | A thrown error or its message (those become `internal_error`) |
| Outcome unknown | The meaning of `timed_out`, `cancelled`, and `internal_error`: the executor stopped waiting, and the handler may or may not have completed its effect | Proof that nothing happened |
| Late settlement | A handler finishing after the executor already returned `cancelled` or `timed_out`; logged as `tool.settled_late`, never changing the caller's result | A retry |
| Risk level | `read`, `write`, `destructive`, or `external`; drives the policy decision | Log level |
| Confirmation | Explicit approval from the user or host, obtained outside the model | The model saying the user agreed |
| Host | The process presenting tools to a model: the CLI agent or an MCP client | The OpenAI or MCP SDK |
| Idempotency key | Required input of every write tool naming one logical operation; owned by the executor's caller — in the agent loop the host, never the model. Scope: the whole note store; it lives as long as its note | Exactly-once delivery (never claimed); a transport or tool-call id |
| Replay | A repeated `create_note` with a used key and the same text: returns the original note with `created: false` and writes nothing | A conflict (same key, different text) |
| Commit point | The single step after which a write is durable and visible: for notes, the successful hard link of the fsynced temp file to the note's name | Writing the temp file |
| Port / adapter | Port: an interface the application owns (`src/ports`). Adapter: its implementation for a provider, protocol, or the OS (`src/adapters`) | A protocol adapter's business logic (there is none) |
| Note | A short, immutable text record (`id`, `text`, `createdAt`) created by `create_note` and read by `read_note`; one JSON file under `DATA_DIR/notes`, its id derived from its idempotency key | A file path chosen by the model |
| Dry run | Shows the proposed tool calls and policy decisions without performing side effects | A test run with fakes |

## Maintenance

Add a term the first time two people (or an agent and a person) meant different things by it.
Rename in code when a term changes here; a glossary that disagrees with the code is worse than none.
