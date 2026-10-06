# anti-slop — provenance

- Source repository: https://github.com/dmmulroy/anti-slop
- Source revision: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (upstream `HEAD`, fetched
  2026-10-06)
- Copied from: upstream `skills/install-anti-slop/assets/anti-slop/` via its `scripts/install.mjs`
- Installed path: `tools/oxlint/anti-slop/` (generic plugin; the opt-in Effect plugin is present
  but not registered — the project does not depend on `effect`)
- Peer dependency: `@oxlint/plugins` pinned to the installed `oxlint` version (1.87.0)
- Configuration: `oxlint.config.ts` (all generic rules at `error`, plus `oxc/no-accumulating-spread`)
- Intentional deviations: none. Vendored `vendor/eslint-stylistic/LICENSE` and its `UPSTREAM.md`
  are kept.
