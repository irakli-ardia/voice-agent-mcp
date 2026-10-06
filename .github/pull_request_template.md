## What and why

<!-- One or two sentences. Link the issue or design discussion if there is one. -->

## Checks run locally

| Check | Result |
| --- | --- |
| `npm run lint` | |
| `npm run typecheck` | |
| `npx vitest run --changed` | |
| `node scripts/checks/docs-check.mjs` | |
| Runtime verification | <!-- what you exercised, where --> |

Skipped checks and why:

## Docs updated

- [ ] `docs/architecture/` or `docs/coding-standards.md` if a boundary or rule changed
- [ ] New record in `docs/decisions/` for a hard-to-reverse choice
- [ ] `README.md` if user-visible behaviour changed

`do-not-merge` stays on until every relevant check above passed on the final commit.
