# Glossary

Terms that could be read more than one way, with the meaning this project uses. Code, docs, and
CLI output use these words consistently; a design discussion adds to this list when it settles a term.

| Term | Meaning here | Not to be confused with |
| --- | --- | --- |
| Turn | One user request (text or audio) processed to a final answer and optional speech; identified by `turnId` | A whole conversation or session |
| Agent iteration | One model request/response round inside a turn; capped by `MAX_AGENT_ITERATIONS` | A turn |
| Tool definition | The single canonical object: name, description, input and output Zod schemas, risk, timeout, confirmation flag, handler | An OpenAI function definition or MCP tool entry (both are derived from it) |
| Tool registry | The set of tool definitions, looked up by exact name only | Dynamic property lookup on an object |
| Tool executor | The one pipeline every tool call passes: lookup → validate input → policy → confirmation → timeout → execute → validate output → map errors → log | A tool handler |
| Tool call | A request from the model or an MCP client to run a named tool with raw (untrusted) arguments; identified by `toolCallId` | A tool execution that already passed validation |
| Risk level | `read`, `write`, `destructive`, or `external`; drives the policy decision | Log level |
| Confirmation | Explicit approval from the user or host, obtained outside the model | The model saying the user agreed |
| Host | The process presenting tools to a model: the CLI agent or an MCP client | The OpenAI or MCP SDK |
| Idempotency key | Caller- or host-provided key that scopes duplicate suppression for a side-effecting tool | Exactly-once delivery (never claimed) |
| Port / adapter | Port: an interface the application owns (`src/ports`). Adapter: its implementation for a provider, protocol, or the OS (`src/adapters`) | A protocol adapter's business logic (there is none) |
| Note | A short local text record created and read by tools, stored only in the application-owned data directory | A file path chosen by the model |
| Dry run | Shows the proposed tool calls and policy decisions without performing side effects | A test run with fakes |

## Maintenance

Add a term the first time two people (or an agent and a person) meant different things by it.
Rename in code when a term changes here; a glossary that disagrees with the code is worse than none.
