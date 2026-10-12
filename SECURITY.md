# Security policy

## Supported versions

voice-agent-mcp is a pre-1.0 reference implementation. Only the latest commit on `main` receives
fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's **Report a vulnerability** button
(private security advisories) on this repository. Do not open a public issue. Include the
affected version or commit, reproduction steps, and the impact you observed. There is no security
email address. Please do not disclose the issue publicly (issues, pull requests, social media)
until a fix is released or we have agreed a date together (coordinated disclosure).

This is a volunteer-maintained project: I aim to acknowledge a report within a few days, but I
cannot promise a response or fix deadline. Reporters are credited in the advisory unless they
prefer otherwise.

If the button is missing, private vulnerability reporting is not enabled on the repository yet
(owner: Settings → Code security → Private vulnerability reporting). In that case open a public
issue asking for a private contact channel, **without** vulnerability details.

## Dependencies

Dependabot opens pull requests for npm and GitHub Actions; it never merges. Updates to `openai`
and `@modelcontextprotocol/*` come as separate pull requests and need a manual review. The
Dependabot file alone does not enforce that: it cannot require a human approval or stop an
owner-configured auto-merge, so keep auto-merge off and require reviews in branch rules. CI audits
production dependencies (`npm audit --omit=dev --audit-level=high`) and runs CodeQL; details in
[docs/architecture/security.md](docs/architecture/security.md#dependency-security).

## Secret handling

- API keys are read only from the environment (`.env` is git-ignored); `.env.example` holds names
  and placeholders only.
- Secrets are never logged: the logger redacts known secret fields, and configuration errors name
  the variable, never its value.
- Default test runs and CI use fakes and never need a real key.

## Scope

In scope: the CLI (including audio input and speech output files), tool execution and its policy,
configuration, logging, and file-backed notes in the application data directory; the MCP stdio
server (`voice-agent mcp`). Out of scope: the security of OpenAI's
service, MCP host applications, and the machine the tool runs on. The local stdio MCP transport has
no authentication by design: the host process is the trust boundary. Trust boundaries and threats
are described in [docs/architecture/security.md](docs/architecture/security.md) (threat
model planned in M6).
