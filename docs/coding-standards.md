# Coding standards

The rules every change follows. Architecture and layer rules are in
[architecture](architecture/README.md); tests in [testing](testing.md); branches, commits, and pull
requests in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Principles

- Keep protocol adapters and entrypoints thin — translate, validate, map errors, delegate to the
  executor or an app service. No business logic in entrypoints, OpenAI/MCP adapters, or
  persistence adapters.
- Parse untrusted data at boundaries (env, CLI arguments, model tool arguments, MCP input, files,
  provider responses) with a Zod schema; pass typed values inward.
- Boring, explicit code over clever abstractions. Three similar lines beat a premature helper. No
  option, generic, or extension point that no planned feature needs; an interface with one
  implementation exists only at an I/O boundary.
- Thread an `AbortSignal` and a timeout through every call that leaves the process.
- Read the installed version's documentation and types before writing code against a library;
  never write fast-moving APIs (OpenAI, MCP) from memory.
- A new production dependency needs a stated reason (what it does better than a small first-party
  implementation) and, if surprising, a [decision record](decisions/README.md).
- Don't use `console`: log through the `Logger` port; CLI output goes through the I/O handed to
  `runCli`.
- No magic values: deployment values and limits live in `src/config/config.ts`; a tool's own
  limits live in its tool folder; protocol constants live in the adapter that uses them.
- Write no comments by default; add one only when the *why* is non-obvious.

## TypeScript

`tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`,
`noPropertyAccessFromIndexSignature`, `useUnknownInCatchVariables`, `noUnusedLocals`,
`noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`, and
`forceConsistentCasingInFileNames`, with `NodeNext` ESM (`.js` import extensions). Never relax them
to make an error go away.

Forbidden in first-party source (`src/`, `tests/`, root config files):

- explicit or implicit `any`; `as SomeType` used to silence the compiler; angle-bracket
  assertions; double casts through `unknown`; non-null `!`; `@ts-ignore`; `@ts-nocheck`;
- unchecked `JSON.parse` flowing into application logic; broad `object` or `Function` types where a
  schema or signature can exist;
- `process.env` reads outside `src/config`.

Enforced by Biome (`noExplicitAny`, `noNonNullAssertion`, `noProcessEnv`), oxlint with the
vendored anti-slop rules, and `tests/architecture/forbidden-type-escapes.test.ts`.

### When third-party typing forces an assertion

Prefer a small validated adapter or type guard. If an assertion is truly unavoidable:

1. isolate it in one adapter file;
2. prove the runtime invariant immediately before it;
3. write a `// SAFETY:` comment saying why upstream typing makes it necessary;
4. add a focused test;
5. add the file and reason to `ALLOWED` in `forbidden-type-escapes.test.ts` and to the list below.
   It never leaks into `src/app`, `src/domain`, or `src/tools`.

Approved exceptions: none.

### Modelling

- `unknown` at trust boundaries, narrowed with a Zod schema or a type guard.
- Types inferred from schemas (`z.infer` / `z.output`), never a parallel interface for the same
  shape.
- Discriminated unions, exhaustive `switch` with a `never` check, `readonly` data, `satisfies`.
- Branded identifiers only where they prevent a real mix-up. Explicit return types on exported
  functions. No type gymnastics for their own sake.

### Errors

- Expected failures are explicit: a `Result` (`src/domain/result.ts`) whose error carries a stable
  `code` and a safe public message; internal causes go to logs only. A tool reports an expected
  failure as a declared reason with a static message, never as runtime text
  ([tool system](architecture/tool-system.md#expected-failures-stay-client-safe)).
- Exceptions are for exceptional infrastructure failures and are mapped at boundaries: provider
  error → adapter mapping → application error → protocol-safe representation.
- Preserve causes (`new SomeError("…", { cause: error })`). Never swallow an error, never
  `catch (error) { throw error; }`, never match on message text.

## Where code goes

| You are adding | It goes in |
| --- | --- |
| Error or result type, other provider-free domain primitive | `src/domain/` |
| Interface the app needs from the outside world | `src/ports/<role>.ts` |
| A model-callable tool | `src/tools/<tool-name>/` ([tool system](architecture/tool-system.md#adding-a-tool)) |
| The tool definition contract (`defineTool`, tool context) | `src/tools/tool-definition.ts` |
| Registry, executor, or policy | `src/app/tools/` |
| Agent loop | `src/app/agent/` |
| Transcribe / synthesize services | `src/app/audio/` |
| OpenAI mapping and errors | `src/adapters/openai/` |
| MCP server and registration | `src/adapters/mcp/` |
| Note storage | `src/adapters/persistence/` |
| Clock, ids, logger implementations | `src/adapters/system/`, `src/adapters/logging/` |
| Env var or limit | `src/config/config.ts` and `.env.example`, in the same change |
| Wiring adapters to ports | `src/bootstrap/create-application.ts` |
| CLI parsing and exit codes | `src/entrypoints/cli.ts` |
| Test, fake, or fixture | `tests/` ([testing](testing.md)) |

Something only one file uses stays in that file or beside it.

## Naming and files

- Files and folders are kebab-case ASCII (Biome `useFilenamingConvention`). One primary export per
  file, named after it: `tool-registry.ts` → `createToolRegistry`.
- Ports are named for their role, one interface per file: `src/ports/clock.ts` → `Clock`.
- Suffixes: `*-store.ts` (persistence adapter for one record type), `*-mapper.ts` (protocol ↔
  canonical translation), `*-errors.ts` (one provider's error mapping), `*.test.ts` (tests under
  `tests/`, mirroring `src/`).
- Name for the domain, never `utils`, `helpers` (outside `tests/helpers/`), `common`, `misc`, or
  `manager`. Model-facing tool names are `snake_case` (`create_note`); their folders are kebab-case.
- No `export *` (Biome `noReExportAll`); imports point inward only (architecture layer rules).
- Split on a measured trigger (cognitive complexity or function length reported by Biome or
  fallow), not on line counts; don't extract a wrapper that only forwards arguments.
