# Testing

How correctness is proven: deterministic tests with fakes at every provider boundary, architecture
tests for the dependency rules, and coverage thresholds enforced in CI.

```bash
npm test
npx vitest run --changed
```

| Command | Runs |
| --- | --- |
| `npm test` | Every test under `tests/` (Vitest 5), no network |
| `npm run test:coverage` | Same, with v8 coverage and thresholds (lines/functions/statements 90 %, branches 85 %) |
| `npm run check:architecture` | `tests/architecture/` — dependency direction, `process.env` ownership, filesystem access only in persistence adapters, forbidden type escapes, the single tool execution path |
| `npm run check:forbidden-types` | Only the forbidden-type-escape scan |
| `npx vitest run --changed` | Tests affected by uncommitted changes |
| `npm run test:openai` | Opt-in live suite in `tests/live/` against the real OpenAI API (builds first). Needs `OPENAI_API_KEY` and the network, and spends API credits; never part of `npm test`, `npm run check`, or CI |

`npm test`, `npm run check`, and CI never need an API key, the network, or a live model: the OpenAI
adapter is tested against the real SDK client with an injected `fetch` (`tests/helpers/fake-fetch.ts`),
and the agent loop against a scripted `AgentModel` (`tests/helpers/fake-agent-model.ts`). Speech is
covered the same way ([speech](#speech)). Coverage excludes only the bin
`src/entrypoints/voice-agent.ts`; `runCli` in `src/entrypoints/cli.ts` takes its I/O, abort signal,
and composition as parameters and is unit-tested.

## Layout

```
tests/
  unit/<src path>/<file>.test.ts   one file per source file, mirroring src/
  architecture/                    invariants scanned from source (imports, env, type escapes)
  contract/                        registry contract: names, descriptions, risk, failures, schemas (M1); adapters use the same registry (M3/M5)
  integration/                     real wiring: notes on the file store through the executor; a whole agent turn with a fake model; ask with audio and speech on the real filesystem; MCP server in memory (M5)
  live/                            opt-in checks against the real OpenAI API (`npm run test:openai`)
  helpers/                         typed fakes, audio header builders, a loopback Realtime server, scanners
```

## Conventions

- Each test states one situation and asserts what a caller observes, not how the code is
  structured internally. No huge provider-payload snapshots.
- Fake at port boundaries (`Clock`, `IdGenerator`, `NoteStore`, `AgentModel`, `SpeechToText`,
  `TextToSpeech`, `AudioFiles`) with typed fakes in `tests/helpers/`; never module-mock
  implementation internals. Test the OpenAI adapter through the real SDK client with a scripted
  `fetch`, never by mocking the SDK. CLI tests pass their own composition (`createAgent` backed by
  the fake model) and their own abort signal.
- Test the file note store against the real filesystem in a fresh temporary directory, including
  50 concurrent creates with one key. Replace one of its `NoteFiles` steps only for a branch a real
  disk cannot produce on demand (an fsync or link failure); never replace the whole adapter.
- Test a tool through the real executor (`tests/helpers/run-tool.ts`), as every production caller
  runs it. Compile-time contracts that must *not* compile are proved by compiling fixtures with the
  real TypeScript compiler (`tests/unit/tools/tool-definition.test.ts`), never with
  `@ts-expect-error`.
- No sleep-based timing: inject the clock and use Vitest fake timers or `AbortSignal`s. The one
  exception is tests over real sockets (the loopback Realtime server, stalled HTTP bodies), which
  wait briefly for real I/O to happen.
- A bug fix lands with a test that fails without the fix. Behaviour lands with its tests in the
  same change, not after.
- `.only` is rejected (`allowOnly: false`); a skipped test carries its reason in the test name or
  an adjacent comment.
- Architecture rules are enforced twice on purpose: in config (fallow zones in `.fallowrc.json`,
  Biome overrides) and in `tests/architecture/`, so the rules are visible as tests too. An
  exception is an inline `fallow-ignore-next-line` or `biome-ignore` comment with its reason —
  debt to shrink, never an example.

## Speech

- **No binary fixtures.** Audio headers are built in code (`tests/helpers/audio-bytes.ts`); format
  detection is tested against every accepted signature and near-miss.
- **Speech-to-text** runs through the real SDK client with a scripted `fetch` that records the
  multipart upload, plus two tests that point the real platform `fetch` at a stalled local HTTP
  server to show how a response body that never finishes is bounded.
- **The Realtime renderer** runs against a loopback WebSocket server
  (`tests/helpers/fake-realtime-server.ts`) through the real platform `WebSocket`: handshakes
  (stalled, rejected), the exact request, every event and failure, malformed frames, the PCM cap,
  cancellation in every state, and a server that never finishes the close handshake.
- **Local audio files** run on the real filesystem in a temporary directory: limits, symlinks,
  races, ownership, permissions. POSIX-only cases (FIFO, `/dev/zero`, mode `0600`) and Windows-only
  cases (device paths) are skipped on the other platform with the reason in the test name.
- **The CLI flows** run with the real speech services over fakes (stage order, D1, exit codes,
  cancellation at each stage, privacy), and once on the real filesystem
  (`tests/integration/voice-ask.test.ts`).
- **CI** runs the suite on Linux (Node 22 and 24) and Windows (Node 24); it never calls OpenAI.
- **Live speech verification** is manual and owner-approved, never in CI: run the built CLI with a
  key for each of the four `ask` flows using short synthetic audio, and record metadata only —
  exit codes, event names, timings, sizes, token counts — never audio, transcriptions, or answers
  of real requests.

## What to cover

Every tool; input and output validation; registry lookup; error mapping; retry policy; timeouts;
confirmation policy; idempotency; config parsing; agent-loop decisions; speech flows and file
safety; cancellation. Critical
executor, policy, and agent-loop code should be near-complete; don't chase 100 % on trivial code.

## What counts as verified

Unit tests prove logic. They do not prove the CLI wires a command, that the MCP server keeps stdout
clean, or that a real provider accepts the request. For those, run the built CLI, the live suite,
or the MCP Inspector and note what you observed in the pull request — metadata only: no prompts
with user data, responses, reasoning, tool payloads, headers, or keys.

The live suite covers: strict tool schemas accepted, including an empty object, string bounds, and
nesting (hard); stateless continuation over two dependent tool rounds with each reasoning effort,
counting reasoning items sent back (hard); several calls allowed per response; a recorded
comparison of reasoning efforts; provider-error classification; and a built-CLI smoke run. It
reports metadata only — outcomes, counts, latency, and token usage. Interrupting a real request is checked by hand: run
`node dist/entrypoints/voice-agent.js ask --text "..."`, press Ctrl+C once while it waits, and expect
exit code 130 and empty stdout; a second Ctrl+C ends the process immediately.
