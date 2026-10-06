# voice-agent-mcp

voice-agent-mcp is a voice-driven OpenAI tool-calling agent whose tools are defined once and also served to MCP clients over stdio.

Most LLM demos stop at generating text. This project focuses on the harder boundary: letting a
model perform real actions without giving up type safety, validation, observability, or control.
Speech is transcribed, an OpenAI Responses API agent selects typed tools, every call runs through
one validated executor, and the answer is spoken back. The same tool definitions are served to
Claude and other MCP clients over stdio. It is a production-grade reference implementation with
documented limits, built milestone by milestone; the current state is M2: the canonical tool
system (tool definition, registry, executor) with two read-only tools and idempotent note tools
(`create_note`, `read_note`) on a file-backed store. No command runs tools yet; the agent arrives in M3 and the MCP server in M5. Generated speech is
AI-generated.

License: [MIT](LICENSE). Security: [SECURITY.md](SECURITY.md). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Need | Read |
| --- | --- |
| How it is built | [Architecture overview](docs/architecture/README.md) |
| How one tool definition serves OpenAI and MCP | [Tool system](docs/architecture/tool-system.md) |
| Trust boundaries and action control | [Security](docs/architecture/security.md) |
| The rules the codebase enforces | [Invariants](docs/architecture/invariants.md) |
| Why the big choices were made | [Decisions](docs/decisions/README.md) |
| How correctness is tested | [Testing](docs/testing.md) |
| Run it locally | [Local setup](docs/local-setup.md) |

## Quick start

```bash
npm install
npm run check
npm run dev -- --help
```
