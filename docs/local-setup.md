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

With audio and speech (same key; no other credentials):

```bash
node --env-file=.env dist/entrypoints/voice-agent.js ask --audio question.wav
node --env-file=.env dist/entrypoints/voice-agent.js ask --audio question.wav --speech-out answer.wav
```

`--audio` accepts WAV, MP3, MP4/M4A, or WebM up to 8 MiB. `--speech-out` must name a new `.wav`
file in an existing directory; it is never overwritten. The saved voice is AI-generated, not a
human voice.

stdout carries only the answer; structured logs go to stderr (`LOG_LEVEL=silent` hides them). If
speech fails after the answer was printed, the answer stays on stdout and the exit code reports the
failure.
Exit codes: 0 success, 64 usage error or unusable input (unreadable or unsupported audio, output
file exists), 78 configuration error (including a missing key for `ask`), 69 a provider
unavailable, 75 a deadline passed (turn or speech), 130 interrupted (Ctrl+C), 70 internal error,
1 any other failure.

## Configuration

Every variable is in `.env.example` with its default and bounds; invalid values exit 78 and name
the variable, never the value.

| Area | Variables |
| --- | --- |
| Secret | `OPENAI_API_KEY` (read only by `ask`) |
| Agent | `OPENAI_MODEL`, `OPENAI_REASONING_EFFORT`, `OPENAI_MAX_OUTPUT_TOKENS`, `OPENAI_TIMEOUT_MS`, `MAX_AGENT_ITERATIONS`, `MAX_TOOL_CALLS_PER_TURN`, `MAX_INPUT_TEXT_CHARS`, `AGENT_TURN_TIMEOUT_MS` |
| Speech | `OPENAI_STT_MODEL` (`gpt-transcribe`), `OPENAI_TTS_MODEL` (`gpt-realtime-2.1-mini`), `OPENAI_TTS_VOICE` (`marin`), `SPEECH_TIMEOUT_MS` (180000) |
| Shared | `OPENAI_MAX_RETRIES`, `LOG_LEVEL`, `MAX_TOOL_RESULT_BYTES`, `DATA_DIR` |

Fixed in code, not configuration: the 8 MiB audio input limit, the 800-character limit for spoken
answers, and the 9 600 000-byte PCM cap per rendering.

## Running

| What | Command | Port |
| --- | --- | --- |
| CLI from source | `npm run dev -- <command>` (with the key exported in your shell for `ask`) | — |
| Built CLI | `npm run build && npm start -- <command>` | — |
| MCP stdio server (M5) | `npm run mcp` (planned) | — (stdio) |

## Gotchas

None recorded yet.
