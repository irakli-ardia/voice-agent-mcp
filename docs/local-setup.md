# Local setup

Secrets are never written here. Real values live in `.env` (gitignored); `.env.example` lists every
variable.

## Prerequisites

- Node.js 24 LTS (22.12 or later also works; CI runs both) with npm.
- Git (the `prepare` script installs the repository's git hooks on `npm install`).
- No database, Docker, or cloud CLI. An OpenAI API key is needed only for `ask`; `--help`, `tools`,
  and every test (`npm test`, `npm run check`, CI) run without one.

## First run

```bash
npm install
npm run check                 # the full local gate, no key or network needed
npm run dev -- tools          # the tools the agent can call
```

To ask a question, put `OPENAI_API_KEY` in the environment. The CLI reads only the process
environment and does not load `.env` itself; Node can load it for you:

```bash
cp .env.example .env          # then set OPENAI_API_KEY in .env
npm run build
node --env-file=.env dist/entrypoints/voice-agent.js ask --text "What is 12 times 7?"
```

stdout carries only the answer; structured logs go to stderr (`LOG_LEVEL=silent` hides them).
Exit codes: 0 answered, 64 usage error, 78 configuration error (including a missing key for `ask`),
69 model service unavailable, 75 turn deadline passed, 130 interrupted (Ctrl+C), 70 internal
error, 1 any other failed turn.

## Running

| What | Command | Port |
| --- | --- | --- |
| CLI from source | `npm run dev -- <command>` (with the key exported in your shell for `ask`) | — |
| Built CLI | `npm run build && npm start -- <command>` | — |
| MCP stdio server (M5) | `npm run mcp` (planned) | — (stdio) |

## Gotchas

None recorded yet.
