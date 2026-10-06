# Contributing

## Setup

```bash
npm install            # also installs the git hooks (prepare script)
cp .env.example .env   # optional until OpenAI-backed commands exist
npm run check          # the full local merge-quality gate
```

Details: [docs/local-setup.md](docs/local-setup.md). Before writing code, read the
[architecture overview](docs/architecture/README.md) and the
[coding standards](docs/coding-standards.md).

## Branches and commits

Enforced by the git hooks in `.githooks/` and by CI on every pull request.

- Never commit to `main` directly. Branches are `<type>/<kebab-case-description>`
  (e.g. `feat/tool-registry`). Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`,
  `ci`, `chore`, `revert`, `hotfix`, `release`; `dependabot/*` is reserved.
- Commit subjects and PR titles follow Conventional Commits: `<type>(optional-scope): summary`,
  lowercase summary, no trailing period, at most 72 characters; `!` before the colon marks a
  breaking change, explained in the body.
- Keep commits atomic: one reviewable concern with its tests and docs.
- Never bypass hooks with `--no-verify`. CI is authoritative.
- Check a branch before pushing: `node scripts/git/conventions.mjs current`.
- Before committing, review what will be tracked (`git status --porcelain`). Never commit secrets,
  `.env` files, runtime data, caches, or local editor and assistant configuration.

## Checks

| Check | Command |
| --- | --- |
| Everything | `npm run check` |
| Lint + format | `npm run lint`, `npm run format:check` |
| Types | `npm run typecheck` |
| Tests + coverage | `npm test`, `npm run test:coverage` |
| Architecture invariants | `npm run check:architecture`, `npm run check:forbidden-types`, `npm run fallow` |
| Docs | `npm run docs:check` |
| Build | `npm run build` |

## Pull requests

1. **Before opening:** run the relevant checks and list each with its result in the PR body,
   including anything skipped and why ([PR template](.github/pull_request_template.md)).
2. **Opening:** add the `do-not-merge` label whenever a check was not run, failed, or its output was
   not read. The **Merge gate** workflow fails while it is set.
3. **After every push:** if the push adds code that was not verified locally, re-add
   `do-not-merge`.
4. **Merging:** remove `do-not-merge` only after every relevant check passed on the final head
   commit. A passing typecheck is not verification — exercise the changed behaviour.

## Documentation

Docs change in the same pull request as the behaviour they describe: the
[architecture docs](docs/architecture/README.md) when a boundary or rule changes, a new
[decision record](docs/decisions/README.md) for a hard-to-reverse choice, and the README when
user-visible behaviour changes. `npm run docs:check` fails on broken links, missing anchors, and
links to files that are not published.

## Adding a tool

Follow the [tool checklist](docs/architecture/tool-system.md#adding-a-tool): one folder in
`src/tools/<tool-name>/`, Zod input and output schemas, risk metadata, a handler written against
ports, one registry entry, and unit tests. OpenAI and MCP pick it up automatically — never add a
tool definition to an adapter.

## Adding an adapter

Follow [layers and ports](docs/architecture/layers-and-ports.md#adding-a-port-and-adapter): port
first, typed fake and caller tests second, adapter with error mapping third, wiring in
`src/bootstrap/` last. No placeholder adapters for providers that are not implemented.

## Testing expectations

Tests land with the behaviour, not after it. Cover success, invalid input, provider or tool
failure, timeout, cancellation, and duplicate/idempotent behaviour where relevant. Default test
runs never call a real provider. Details: [docs/testing.md](docs/testing.md).
