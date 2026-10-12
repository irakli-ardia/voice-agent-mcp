# voice-agent-mcp

A voice-driven OpenAI tool-calling agent for the command line, and an MCP server for the same
tools. You ask by text or with an audio file; an agent on the OpenAI Responses API answers, calling
typed tools when it needs to; the answer is printed and can also be saved as speech. The tools are
defined once, and the same definitions run behind the agent and behind `voice-agent mcp`, which
serves them to any MCP client over stdio.

The point of the project is letting a model take real actions safely. Every tool is one TypeScript
definition with Zod input and output schemas, a risk level, a timeout, and declared failures; every
call, whether the agent's model or an MCP client makes it, goes through one executor that validates
the arguments, applies policy and a deadline, validates the result, and logs the outcome.

What the code demonstrates:

- **Strict runtime validation** of everything the model, an MCP client, the environment, the disk,
  or a provider supplies.
- **Define a tool once:** the OpenAI function tools and the MCP tool descriptors are both projected
  from the same registry, and neither adapter has a handler of its own.
- **A bounded agent loop:** limits on model calls and tool calls per turn, a turn deadline, and
  bounded, cancellable retries; stateless Responses requests (`store: false`).
- **Idempotent writes:** write tools take a key, so a retried write never repeats its effect. In the
  agent loop the host derives the key and the model never sees it; over MCP the client supplies it.
- **An MCP server with honest limits:** both current protocol eras over stdio, cancellation that
  reaches the executor (and says plainly that it does not undo a committed write), a cap on
  concurrent calls, a 1 MiB inbound limit, and stdout reserved for protocol messages.
- **Speech in:** audio files are checked locally (format and size) before upload, then transcribed
  with `gpt-transcribe`.
- **Speech out:** the final answer is spoken by an OpenAI Realtime model used strictly as a
  renderer — no tools, the answer as data — and saved only if the speech matches the answer word
  for word.
- **Safe files:** a speech file is created exclusively before anything is spent, never overwrites
  anything, and is removed on any failure.
- **Typed errors with safe messages,** stable exit codes, and structured logs on stderr with no
  prompts, answers, transcriptions, audio, paths, keys, or the contents of an exception.
- **Deterministic tests** with fakes at every provider boundary, a local WebSocket server for the
  Realtime protocol, and real child processes for the compiled MCP server; the full check runs on
  Linux and Windows without an API key.

## Usage

```bash
voice-agent ask --text "What is 12 times 7?"                         # text in, text out
voice-agent ask --audio question.m4a                                 # audio in, text out
voice-agent ask --text "What time is it?" --speech-out answer.wav    # text in, text and speech out
voice-agent ask --audio question.wav --speech-out answer.wav         # audio in, text and speech out
voice-agent tools                                                    # the tools the agent can call
voice-agent mcp                                                      # serve those tools to an MCP client over stdio
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
  `voice-agent mcp` has its own exit codes, listed [below](#the-mcp-server).

Tools today: `get_current_time`, `calculate`, and `create_note` / `read_note` on a file-backed,
idempotent note store.

## Quick start

```bash
npm ci
npm run check                    # docs, lint, types, architecture rules, tests, built-server tests — no key needed
npm run build
cp .env.example .env             # then set OPENAI_API_KEY in .env (only `ask` needs it)
node --env-file=.env dist/entrypoints/voice-agent.js ask --text "What is 12 times 7?"
```

Configuration (models, voice, limits, deadlines) is read from the environment and validated at
startup; `.env.example` lists every variable. Details: [local setup](docs/local-setup.md).

## The MCP server

`voice-agent mcp` is a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio. It
exposes exactly the tools the agent uses, runs every call through the same executor, and **needs no
OpenAI API key**: no provider is loaded. An MCP client starts it as a child process; you do not run
it by hand.

```bash
npm ci
npm run build
node dist/entrypoints/voice-agent.js mcp     # waits for an MCP client on stdin/stdout
```

### Connect a client

Most stdio MCP clients take a server entry of this shape. **`DATA_DIR` is required and must be an
absolute path**; replace both placeholders with your own absolute paths (on Windows, use forward
slashes or escape each backslash):

```json
{
  "mcpServers": {
    "voice-agent": {
      "command": "node",
      "args": ["<path-to-this-checkout>/dist/entrypoints/voice-agent.js", "mcp"],
      "env": { "DATA_DIR": "<absolute-path-for-notes>" }
    }
  }
}
```

- Build first (`npm run build`); the entry point is the compiled JavaScript. Start it with `node`, not
  through `npm start`: npm prints a banner on stdout, which is not an MCP message and breaks the
  protocol (`npm start --silent -- mcp` is safe).
- `DATA_DIR` is where notes are stored (under `<DATA_DIR>/notes`). The server **refuses to start**
  without it: it exits 78 with `DATA_DIR: must be set to an absolute directory path for this
  command`, or `must be an absolute path` for a relative one, and writes nothing. There is no
  default and a relative path is never resolved, because a client may start the server in any
  working directory (often your project) and notes would land there. The message never repeats the
  value. Examples of a valid value:

  | System | `DATA_DIR` |
  | --- | --- |
  | Windows | `C:/Users/<you>/AppData/Local/voice-agent` (JSON: `"C:\\Users\\<you>\\AppData\\Local\\voice-agent"`) |
  | Linux | `/home/<you>/.local/share/voice-agent` |
  | macOS | `/Users/<you>/Library/Application Support/voice-agent` |

  Not valid: an empty value, `.data`, `notes`, `./notes`, `~/notes` (no shell expands `~` in this
  file), `\notes` or `C:notes` on Windows, and a path with `< > " | ? *` on Windows. It need not
  exist yet; it must be on a local filesystem with hard links. `ask` and `tools` are unchanged
  and keep `.data` as their default.
- Add nothing secret. The server reads no API key.

It has been tested with the official MCP TypeScript SDK client, in both protocol eras, and with raw
JSON-RPC over real stdio. Other hosts speak the same protocol but have not been tested here.

### What it offers

| Tool | Does | Notes |
| --- | --- | --- |
| `get_current_time` | The current time in UTC and in one time zone | read-only |
| `calculate` | One arithmetic operation on two numbers | read-only |
| `create_note` | Saves a short text note and returns its id | **requires `idempotencyKey`** |
| `read_note` | Returns a saved note by id | read-only |

`tools/list` shows each tool's full input and output schema, taken from the same definitions the
agent uses, and annotations that are hints only.

**`idempotencyKey` is yours to choose.** `create_note` requires one, 16–64 characters of
`A-Z a-z 0-9 - _` (a UUID works). Use a new key for every new note and the same key only to retry a
call whose outcome you do not know: the same key with the same text returns the original note with
`created: false`, and the same key with different text fails. The server never invents, changes, or
reuses a key for you, so a client whose model picks a fresh key on every retry will create a second
note.

Results come back as `structuredContent` plus one text block holding the same JSON. A failed call is
a result with `isError: true` and the text `<code>: <message>`, using the executor's error codes
(`invalid_input`, `timed_out`, `cancelled`, `execution_failed`, `output_too_large`, `overloaded`, `rate_limited`, `server_shutting_down`, …; a full note store is `execution_failed: note_quota_exceeded`); an unknown
tool is the JSON-RPC error -32602.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_MAX_CALLS_PER_SECOND` | 20 (1–1000) | Sustained rate and burst of tool calls; more are refused with `rate_limited` |
| `MCP_MAX_IN_FLIGHT_CALLS` | 16 (1–128) | Tool calls running at once; the next is refused with `server_busy` |
| `MAX_ABANDONED_TOOL_HANDLERS` | 3 (1–64) | Handlers still running after a cancel or timeout before new calls are refused with `overloaded` |
| `MAX_TOOL_RESULT_BYTES` | 16384 | Largest JSON result of one call, in UTF-8 bytes |
| `MAX_NOTES` | 10000 (1–1000000) | The most notes the store holds, across every process sharing `DATA_DIR`; a new note over it fails with `note_quota_exceeded`, a saved note is still returned |
| `DATA_DIR` | `.data` (`ask`, `tools`); **required, absolute** for `mcp` | Where notes are stored. `voice-agent mcp` exits 78 if it is unset, empty, or relative |
| `LOG_LEVEL` | `info` | Logs go to stderr; `silent` hides them |

An invalid value exits with code 78, naming the variable and never its value. Fixed in code: the
1 MiB limit on one inbound message.

### Cancellation, limits, and what is not promised

- **Cancelling a call stops the server waiting; it does not undo anything.** A write that was already
  committing can still finish, and the outcome is unknown to the client. Retry with the **same**
  `idempotencyKey` to learn the result without writing twice. Closing stdin has the same effect on
  every call in flight.
- **`MCP_MAX_CALLS_PER_SECOND` limits how many calls reach a tool, not what a client may send.**
  Every request is still read and answered. A client that stops reading answers makes the server
  stop reading requests once 64 KiB of output is queued; the queue is capped (33 MiB by default,
  past which the connection fails with exit 1) instead of growing without limit. A stop signal while
  the client is not reading ends the process within about 2.5 seconds; the answers still queued are
  not delivered, which is logged.
- **Shutdown is bounded, and a forced exit can interrupt unfinished work.** After stdin closes, or on
  SIGINT or SIGTERM, the server stops accepting calls, tells running ones to stop, and waits at most
  2 seconds for them and for queued answers. If the process is still alive half a second later
  (a tool blocked in I/O, a client that never reads) it is ended with the exit code it would have
  had. A write is either fully published or not visible, but its outcome may be unknown to the
  client: retry with the same `idempotencyKey`.
- **`MCP_MAX_IN_FLIGHT_CALLS` is a concurrency cap.** It does not count a
  tool that is still running after a cancellation or a timeout; `MAX_ABANDONED_TOOL_HANDLERS`
  bounds those by refusing new calls, and the rate limit above is what bounds a fast client.
- A message over 1 MiB ends the server with exit 1. A request with an invalid envelope (for example a
  malformed `_meta`) gets no response at all, so such a client waits until its own timeout.
- Two requests in flight under one JSON-RPC id (which the protocol forbids) both run and share the
  id, and a cancellation reaches only the later one.
- A tool that requires confirmation is always refused over MCP, and the model cannot approve it
  either: approval is a host-issued, single-use grant that no request, argument, or `_meta` can carry.
  No current tool requires it, and there is no interactive confirmation flow yet.
- stdio only: no HTTP transport and no authentication; the process that starts the server is the
  trust boundary.

Exit codes: 0 stdin closed · 1 transport failure · 64 extra arguments · 70 unexpected failure · 78
configuration · 130 SIGINT · 143 SIGTERM (a forced exit keeps the code). Closing stdin is the graceful stop that works on every
platform; on Windows, a host that kills the process gives it no signal to handle.

stdout carries protocol messages only; logs, one JSON object per line, go to stderr and never contain
arguments, results, note text, keys, paths, or the contents of an exception. See [MCP](docs/architecture/mcp.md)
and [security](docs/architecture/security.md#mcp-server) for the details and the known limits; M6 adds
further hardening.

## Architecture

Plain Node.js and TypeScript with explicit composition: ports and adapters, no framework or DI
container. The request path is `entrypoint (CLI or MCP stdio) → composition root → agent runner →
tool executor → tool handler → port → adapter`; the MCP path skips the agent runner. Speech stages run
before and after the agent turn and never inside it. OpenAI and MCP types stay inside their adapters.

| Need | Read |
| --- | --- |
| How it is built | [Architecture overview](docs/architecture/README.md) |
| Tools, the registry, and the executor | [Tool system](docs/architecture/tool-system.md) |
| How a turn runs: limits, retries, model requests | [Agent loop](docs/architecture/agent-loop.md) |
| Speech in and out | [Audio pipeline](docs/architecture/audio-pipeline.md) |
| The MCP server: protocol, results, lifecycle, limits | [MCP](docs/architecture/mcp.md) |
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
| M5 MCP server over stdio | Implemented and tested with the official SDK client, including a built-distribution suite that every CI job runs; checked by hand with the MCP Inspector CLI 2.10.1 and Claude Code 2.1.296 on Windows (see [MCP](docs/architecture/mcp.md#tested-clients)); no other host has been tried |
| M6 Safety hardening (confirmation channel, quotas) · M7 Portfolio polish | Planned |

License: [MIT](LICENSE). Security: [SECURITY.md](SECURITY.md). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).
