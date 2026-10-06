# voice-agent-mcp

voice-agent-mcp is a voice-driven OpenAI tool-calling agent whose tools are defined once and also served to MCP clients over stdio.

The interesting part is not generating text but letting a model take real actions safely. Each
tool is one TypeScript definition with Zod input and output schemas, a risk level, a timeout, and
declared failures. An agent built on the OpenAI Responses API chooses tools; every call it makes
goes through a single executor that validates the arguments, applies policy and a deadline,
validates the result, and logs the outcome. The same definitions will be served to MCP clients
such as Claude over stdio, and speech in and out will wrap the same loop.

What the code demonstrates today:

- **Strict runtime validation** of everything the model, the environment, or the disk provides.
- **A bounded agent loop:** limits on model calls and tool calls per turn, a turn deadline, and
  bounded, cancellable retries.
- **Host-owned idempotency:** write tools take a key the host derives, so the model can neither see
  nor choose it, and a retried write never repeats its effect.
- **Stateless Responses integration** (`store: false`, no server-side conversation), with provider
  types kept inside one adapter.
- **Typed errors with safe messages,** mapped to stable exit codes.
- **Redacted structured logs:** no prompts, answers, tool payloads, or keys.
- **Deterministic tests** with fakes at every provider boundary, so the full check runs without an
  API key.

Status: milestone M3. The `ask --text` command runs the agent loop on OpenAI with four tools:
`get_current_time`, `calculate`, `create_note`, and `read_note`, the last two on a file-backed note
store. Speech input and output arrive in M4 and the MCP server in M5.

License: [MIT](LICENSE). Security: [SECURITY.md](SECURITY.md). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Need | Read |
| --- | --- |
| How it is built | [Architecture overview](docs/architecture/README.md) |
| How one tool definition serves OpenAI and MCP | [Tool system](docs/architecture/tool-system.md) |
| How a turn runs: limits, retries, model requests | [Agent loop](docs/architecture/agent-loop.md) |
| Trust boundaries and action control | [Security](docs/architecture/security.md) |
| The rules the codebase enforces | [Invariants](docs/architecture/invariants.md) |
| Why the big choices were made | [Decisions](docs/decisions/README.md) |
| How correctness is tested | [Testing](docs/testing.md) |
| Run it locally | [Local setup](docs/local-setup.md) |

## Quick start

```bash
npm install
npm run check                     # lint, types, architecture rules, tests, build — no API key needed
npm run dev -- tools              # list the tools the agent can call
```

Asking a question needs `OPENAI_API_KEY` in the environment:

```bash
npm run build
OPENAI_API_KEY=... node dist/entrypoints/voice-agent.js ask --text "What is 12 times 7?"
```

Configuration, exit codes, and loading a `.env` file are in [local setup](docs/local-setup.md).
