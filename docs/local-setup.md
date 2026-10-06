# Local setup

Secrets are never written here. Real values live in `.env` (gitignored); `.env.example` lists every
variable.

## Prerequisites

- Node.js 24 LTS (22.12 or later also works; CI runs both) with npm.
- Git (the `prepare` script installs the repository's git hooks on `npm install`).
- No database, Docker, or cloud CLI. An OpenAI API key is needed only for real-provider runs (M3+); tests never need one.

## First run

```bash
npm install
cp .env.example .env   # then fill in values
npm run dev
```

Nothing else today. `npm run dev` with no command prints usage (commands arrive in M1–M5).
Run the full local gate with `npm run check`.

## Running

| What | Command | Port |
| --- | --- | --- |
| CLI from source | `npm run dev -- <command>` | — |
| Built CLI | `npm run build && npm start -- <command>` | — |
| MCP stdio server (M5) | `npm run mcp` (planned) | — (stdio) |

## Gotchas

None recorded yet.
