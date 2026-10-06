# MCP

The same canonical tools served over the Model Context Protocol. Status: planned (M5).

## v1 transport: stdio

Ideal for local Claude/MCP hosts, smallest attack surface, no HTTP or auth. Streamable HTTP is a
documented future extension, not built unless implementation quality stays high.

## Rules

- Official `@modelcontextprotocol/server` v2. Read the installed package's docs and types before
  writing against it.
- One server factory (`src/adapters/mcp/create-mcp-server.ts`).
- Tool registration is generated from the canonical registry (`register-mcp-tools.ts`), using the
  Zod schemas directly where the SDK supports it.
- Execution is delegated to the canonical executor; results map to MCP typed content
  (`mcp-result-mapper.ts`); failures are represented as MCP tool errors with safe messages.
- No business logic in registration or mapping code; no MCP types in tool handlers.
- **stdout is protocol traffic.** Logs go to stderr only (the pino adapter's default).
- Graceful shutdown with clear lifecycle ownership; no orphaned process or hanging promise.
- Server-side risk metadata and policy hooks are preserved even when the client provides its own
  confirmation UX.

## Verification

- MCP tests create the server programmatically (in-memory transport if the SDK supports it,
  otherwise a controlled stdio test): tools discoverable, schemas correct, valid call succeeds,
  invalid input rejected, expected failure mapped.
- Manual: the official MCP Inspector and at least one documented host configuration.
