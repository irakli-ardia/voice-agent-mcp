# Threat model

What the project defends against, where, and what it deliberately does not. Mechanisms are in
[security](architecture/security.md), [MCP](architecture/mcp.md), and
[invariants](architecture/invariants.md); this page names the threats and the residual risk. It
describes behaviour that is tested, not a proof: passing tests show the listed cases, not that no
other attack exists.

## Assets

- The OpenAI API key (CLI only; the MCP server needs none).
- Notes under `DATA_DIR`, and the filesystem around it.
- Availability of the process an MCP host starts, and of the host's machine (memory, CPU, disk).
- The integrity of what a tool reports: a `created` note exists; a refusal wrote nothing.

## Actors and trust

| Actor | Trusted? | Why it matters |
| --- | --- | --- |
| The model (OpenAI) | No | Chooses tool names and arguments; can be steered by user text |
| An MCP client | No (but local) | Any process that can write the server's stdin; sends arbitrary JSON-RPC |
| The MCP host / operator | Yes | Chooses the command line, environment, `DATA_DIR`, and reads stderr |
| Other local processes on the same `DATA_DIR` | Partly | Other servers of this project cooperate; arbitrary writers are out of scope |
| OpenAI's service | Not for availability | Slow, failing, or malformed responses are expected |
| Dependencies and CI actions | Pinned and audited, not trusted blindly | See Supply chain |

## Threats and mitigations

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Hostile arguments reach a handler | Strict Zod input schemas, unknown keys refused, one executor for every path | Handler bugs inside valid input |
| A tool runs without the user's consent | Destructive tools need a host-issued, single-use `ConfirmationGrant` scoped to tool name and call id; nothing the model or an MCP client sends can construct one | No production tool is destructive yet and no host issues grants; a grant proves a host said yes, not that a person did |
| A slow or stuck handler holds the server | Per-tool deadline; abandoned handlers counted and capped (`MAX_ABANDONED_TOOL_HANDLERS`), then `overloaded` | JavaScript cannot stop a handler: it runs on, and a client can make the server refuse every call for as long as three stuck handlers last |
| Request flood | Token bucket (`MCP_MAX_CALLS_PER_SECOND`), in-flight cap, 1 MiB message limit | A refusal still costs parsing; the rate limit bounds work done, not bytes received |
| Client that never reads answers | Input is paused at 64 KiB of queued output; a hard queue limit fails the connection | Memory use up to the documented limit (about 33 MiB at defaults, up to about 416 MiB at the largest settings); a client that keeps stdin open and never reads can hold the server until a signal |
| Unbounded note growth | `MAX_NOTES` slots, enforced across processes without a lock | After a power loss the count can exceed the limit by the notes that lost their slot record |
| Torn or duplicated notes | Atomic exclusive hard link; idempotent keys; recovery only completes, never guesses a writer is dead | Process crash is covered; OS crash and power loss are not guaranteed, directories are never fsynced |
| Path or symlink tricks | Note ids are hex; reads open without following links and check the handle; `DATA_DIR` must be an explicit absolute path for `mcp` | `DATA_DIR` itself is operator-chosen and trusted; its filesystem type and writability are not checked at startup |
| Secrets and data in logs or errors | Structured logs carry codes and counts, never arguments, results, thrown messages, or paths; errors to clients are static | A host that reads stderr sees tool names and call ids; `LOG_LEVEL=debug` is not audited for more |
| Protocol corruption | Only the MCP transport writes to stdout; logs go to stderr | None known |
| A host that stops reading stderr | Bounded non-blocking log queue (128 KiB at most), drop-newest with a `log.dropped` count; the server never waits for stderr | Diagnostics are lost while stderr is stalled and are not durable; on Windows a helper process holds the pipe while the server runs; it is ended with the server, also when the server is killed outright (measured, below) |
| Shutdown loses work | Admission closes, handlers and queued answers get a 2 s grace, then the bin ends the process; `ask` has the same 2.5 s bound | A forced exit can interrupt an unfinished write and drop queued answers and log lines |
| Compromised or vulnerable dependency | Lockfile and `npm ci`; `npm audit` of production dependencies in CI; Dependabot PRs, SDK bumps reviewed by hand | Zero-days; advisories below `high`; devDependencies are not audited by the gate |
| Compromised CI action or workflow | Every action pinned to a commit SHA; least-privilege tokens; no secrets; no `pull_request_target`; CodeQL | Needs the repository settings listed in [security](architecture/security.md#owner-only-repository-settings); not provable locally |

## Out of scope

Authentication and per-client quotas (the stdio transport trusts its host process); network
exposure (there is none); the security of OpenAI's service and of MCP host applications; a hostile
user with write access to `DATA_DIR`; multi-user machines relying on directory permissions alone on
Windows.

## Reporting

See [SECURITY.md](../SECURITY.md).
