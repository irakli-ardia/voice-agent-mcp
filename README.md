# voice-agent-mcp

A voice-driven OpenAI tool-calling agent for the command line. You ask by text or with an audio
file; an agent on the OpenAI Responses API answers, calling typed tools when it needs to; the answer
is printed and can also be saved as speech. Tools are defined once so that the same definitions can
later be served to MCP clients (planned for M5 — **the MCP server is not implemented yet**).

The point of the project is letting a model take real actions safely. Every tool is one TypeScript
definition with Zod input and output schemas, a risk level, a timeout, and declared failures; every
call the model makes goes through one executor that validates the arguments, applies policy and a
deadline, validates the result, and logs the outcome.

What the code demonstrates:

- **Strict runtime validation** of everything the model, the environment, the disk, or a provider
  supplies.
- **A bounded agent loop:** limits on model calls and tool calls per turn, a turn deadline, and
  bounded, cancellable retries; stateless Responses requests (`store: false`).
- **Host-owned idempotency:** write tools take a key the host derives, so a retried write never
  repeats its effect and the model can neither see nor choose the key.
- **Speech in:** audio files are checked locally (format and size) before upload, then transcribed
  with `gpt-transcribe`.
- **Speech out:** the final answer is spoken by an OpenAI Realtime model used strictly as a
  renderer — no tools, the answer as data — and saved only if the speech matches the answer word
  for word.
- **Safe files:** a speech file is created exclusively before anything is spent, never overwrites
  anything, and is removed on any failure.
- **Typed errors with safe messages,** stable exit codes, and structured logs on stderr with no
  prompts, answers, transcriptions, audio, paths, or keys.
- **Deterministic tests** with fakes at every provider boundary and a local WebSocket server for the
  Realtime protocol; the full check runs on Linux and Windows without an API key.

## Usage

```bash
voice-agent ask --text "What is 12 times 7?"                         # text in, text out
voice-agent ask --audio question.m4a                                 # audio in, text out
voice-agent ask --text "What time is it?" --speech-out answer.wav    # text in, text and speech out
voice-agent ask --audio question.wav --speech-out answer.wav         # audio in, text and speech out
voice-agent tools                                                    # the tools the agent can call
```

- **Audio input:** WAV, MP3, MP4/M4A, or WebM, at most 8 MiB, recognised from the file's content.
- **Speech output:** a new 24 kHz mono 16-bit WAV file; answers longer than 800 characters are not
  spoken. **The voice is AI-generated (OpenAI text-to-speech), not a human voice** — tell listeners
  so when you play it to them.
- **stdout** carries only the answer, once, ending in one newline. If saving the speech fails after
  the answer exists, the answer stays on stdout, one error line goes to stderr, and the exit code is
  non-zero. Before an answer exists, a failure leaves stdout empty.
- **Exit codes:** 0 success · 64 usage or unusable input (unreadable or unsupported audio, output
  file exists) · 69 a provider unavailable · 70 internal error · 75 a deadline passed · 78
  configuration (including a missing `OPENAI_API_KEY`) · 130 interrupted · 1 any other failure.

Tools today: `get_current_time`, `calculate`, and `create_note` / `read_note` on a file-backed,
idempotent note store.

## Quick start

```bash
npm install
npm run check                    # docs, lint, types, architecture rules, tests, build — no key needed
npm run build
cp .env.example .env             # then set OPENAI_API_KEY in .env
node --env-file=.env dist/entrypoints/voice-agent.js ask --text "What is 12 times 7?"
```

Configuration (models, voice, limits, deadlines) is read from the environment and validated at
startup; `.env.example` lists every variable. Details: [local setup](docs/local-setup.md).

## Architecture

Plain Node.js and TypeScript with explicit composition: ports and adapters, no framework or DI
container. The request path is `CLI → composition root → agent runner → tool executor → tool
handler → port → adapter`; speech stages run before and after the agent turn and never inside it.
OpenAI types stay inside their adapters.

| Need | Read |
| --- | --- |
| How it is built | [Architecture overview](docs/architecture/README.md) |
| Tools, the registry, and the executor | [Tool system](docs/architecture/tool-system.md) |
| How a turn runs: limits, retries, model requests | [Agent loop](docs/architecture/agent-loop.md) |
| Speech in and out | [Audio pipeline](docs/architecture/audio-pipeline.md) |
| Trust boundaries, file safety, residual risks | [Security](docs/architecture/security.md) |
| What is logged, and what never is | [Observability](docs/architecture/observability.md) |
| The rules the codebase enforces | [Invariants](docs/architecture/invariants.md) |
| Why the big choices were made | [Decisions](docs/decisions/README.md) |
| How correctness is tested | [Testing](docs/testing.md) |

## Status

| Milestone | State |
| --- | --- |
| M0 Foundation · M1 Canonical tool system · M2 Idempotent side effects · M3 OpenAI agent loop | Done |
| M4 Speech input and output | Done |
| M5 MCP server over stdio | Planned — not implemented |
| M6 Safety hardening (confirmation channel, quotas) · M7 Portfolio polish | Planned |

License: [MIT](LICENSE). Security: [SECURITY.md](SECURITY.md). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).
