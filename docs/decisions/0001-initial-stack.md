# 0001 — Initial stack and repository shape (plain Node.js, explicit composition)

Status: accepted — 2026-10-06

## Context

A public portfolio reference implementation of an LLM agent that performs real actions. Reviewers
must see dependencies, boundaries, composition, and lifecycle without framework conventions
hiding them. The project's non-goals exclude NestJS, DI containers, decorators, reflection, ORMs,
and orchestration frameworks; the goal is a small, deep, explicit codebase.

## Decision

Node.js 24 LTS (engines >=22.12) · npm · ESM · TypeScript 7 strict · OpenAI SDK (Responses API, speech-to-text, text-to-speech) · MCP TypeScript server SDK v2 over stdio · Zod v4 · pino · Vitest + v8 coverage · tsx · Biome + oxlint (anti-slop) + fallow

One npm package at the repository root with layered `src/` folders (domain, ports, app, tools,
adapters, config, bootstrap, entrypoints) and two entrypoints (CLI, MCP stdio). Request path:
entrypoint → composition root → app service → tool executor → tool handler → port → adapter, with
all concrete wiring in `src/bootstrap/create-application.ts`.

## Consequences

- Dependency direction, lifecycle, and testability are visible in plain code and enforced by
  architecture tests, fallow zones, and Biome overrides.
- No framework-provided validation, lifecycle hooks, or DI: each is written explicitly and must
  stay small.
- Engines `>=22.12` keeps the maintained LTS line working (CI runs 22 and 24); `.nvmrc`-style
  pinning is not used.
- Lint stack: Biome for format and general lint; oxlint with the anti-slop plugin for rules Biome
  lacks (type assertions, type-aware promise rules); fallow for layer boundaries, dead code,
  duplication, and complexity. Each extra tool enforces a repository invariant Biome cannot.

## Alternatives considered

- NestJS — hides composition and lifecycle behind decorators and a container; an explicit non-goal.
- pnpm or bun — npm needs no extra install for reviewers.
- Biome only plus custom scripts — fewer tools, but no assertion or boundary enforcement beyond
  regex scans; rejected when the stack was chosen.
