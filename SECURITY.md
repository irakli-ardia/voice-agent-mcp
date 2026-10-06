# Security policy

## Supported versions

voice-agent-mcp is a pre-1.0 reference implementation. Only the latest commit on `main` receives
fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button
(private security advisories) on this repository. Do not open a public issue. Include the
affected version or commit, reproduction steps, and the impact you observed. You will get an
acknowledgement, and the fix will be credited in the advisory unless you prefer otherwise.

## Secret handling

- API keys are read only from the environment (`.env` is git-ignored); `.env.example` holds names
  and placeholders only.
- Secrets are never logged: the logger redacts known secret fields, and configuration errors name
  the variable, never its value.
- Default test runs and CI use fakes and never need a real key.

## Scope

In scope: the CLI, the MCP stdio server, tool execution and its policy, configuration, logging, and
file-backed notes in the application data directory. Out of scope: the security of OpenAI's
service, MCP host applications, and the machine the tool runs on. The local stdio MCP transport has
no authentication by design: the host process is the trust boundary. Trust boundaries and threats
are described in [docs/architecture/security.md](docs/architecture/security.md) (threat
model planned in M6).
