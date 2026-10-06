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
| `npm run check:architecture` | `tests/architecture/` — dependency direction, `process.env` ownership, forbidden type escapes |
| `npm run check:forbidden-types` | Only the forbidden-type-escape scan |
| `npx vitest run --changed` | Tests affected by uncommitted changes |

Planned with their milestones: `test:integration` (fakes, M3+), `test:e2e` (fake-provider audio →
agent → tool → TTS flow, M4), `test:openai` (opt-in real API, `RUN_OPENAI_INTEGRATION=1`, never in
default CI). Coverage excludes only the one-line bin `src/entrypoints/voice-agent.ts`; `runCli` in
`src/entrypoints/cli.ts` takes its I/O as a parameter and is unit-tested.

## Layout

```
tests/
  unit/<src path>/<file>.test.ts   one file per source file, mirroring src/
  architecture/                    invariants scanned from source (imports, env, type escapes)
  contract/                        registry/adapter contracts (M1+): same registry for OpenAI and MCP, unique names, schemas, risk
  integration/                     wiring with fakes (M3+), MCP server in memory (M5)
  fixtures/                        tiny audio and data fixtures
  helpers/                         typed fakes and scanners shared by tests
```

## Conventions

- Each test states one situation and asserts what a caller observes, not how the code is
  structured internally. No huge provider-payload snapshots.
- Fake at port boundaries (`AgentModel`, `SpeechToText`, `TextToSpeech`, `Clock`, `IdGenerator`,
  note store) with typed fakes in `tests/helpers/`; never module-mock implementation internals.
- No sleep-based timing: inject the clock and use Vitest fake timers or `AbortSignal`s.
- A bug fix lands with a test that fails without the fix. Behaviour lands with its tests in the
  same change, not after.
- `.only` is rejected (`allowOnly: false`); a skipped test carries its reason in the test name or
  an adjacent comment.
- Architecture rules are enforced twice on purpose: in config (fallow zones in `.fallowrc.json`,
  Biome overrides) and in `tests/architecture/`, so the rules are visible as tests too. An
  exception is an inline `fallow-ignore-next-line` or `biome-ignore` comment with its reason —
  debt to shrink, never an example.

## What to cover

Every tool; input and output validation; registry lookup; error mapping; retry policy; timeouts;
confirmation policy; idempotency; config parsing; agent-loop decisions; cancellation. Critical
executor, policy, and agent-loop code should be near-complete; don't chase 100 % on trivial code.

## What counts as verified

Unit tests prove logic. They do not prove the CLI wires a command, that the MCP server keeps stdout
clean, or that a real provider accepts the request. For those, run the built CLI or the MCP
Inspector and note what you observed in the pull request.
