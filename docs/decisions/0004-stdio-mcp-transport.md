# 0004 — stdio MCP transport for v1

Status: accepted — 2026-10-06

## Context

The MCP server's first clients are local hosts such as Claude. Remote transports bring HTTP,
authentication, and a larger attack surface.

## Decision

v1 exposes the tool registry over stdio only. Streamable HTTP is documented as an extension point
and built only if quality stays high.

## Consequences

- No authentication on the local transport (an explicit non-goal); the host process is the trust
  boundary.
- stdout carries protocol traffic only; all logs go to stderr.
- The server process must shut down cleanly when the host closes stdin or sends a signal.

## Alternatives considered

- Streamable HTTP in v1 — auth and deployment complexity without a v1 user.
