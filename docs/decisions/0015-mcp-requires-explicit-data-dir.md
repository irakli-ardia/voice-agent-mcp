# 0015 — The MCP server requires an explicit absolute `DATA_DIR`

Status: accepted — 2026-10-12

## Context

`DATA_DIR` defaulted to `.data` and any other value was resolved against the working directory. A
CLI user chooses that directory. An MCP host does not: it starts the server wherever it runs, often
in the user's project, so a missing or relative `DATA_DIR` silently put notes (and, since M6, quota
slots) into that project, where they could be committed or shared. Claude Code, for one, starts a
server in the directory it was launched from with no `DATA_DIR` unless the entry sets it.

## Decision

`loadConfig(env, { dataDir: "explicit-absolute" })`, used only by `runMcpStdio`, adds a policy
before the usual validation: `DATA_DIR` must be set, not blank, and absolute for the platform
(Windows: drive plus separator, UNC share or verbatim drive path; POSIX: a leading `/`; no NUL; on
Windows none of `< > " | ? *`). It is not resolved against the working directory, `~` is not
expanded, and the default is refused. A failure is exit 78 with the existing `Invalid configuration`
message, which names the variable and the rule, never the value, together with any other bad
setting. It runs before the application is built, so nothing is created.

- The policy is an option of the one configuration reader, not a second reader or a check in the
  bin: `ask`, `tools` and `--help` call `loadConfig` without it and are unchanged.
- The directory need not exist; the store creates it on the first write.

## Consequences

- A host entry without `DATA_DIR` now fails visibly (exit 78, message on stderr) instead of writing
  into the project. Documented examples already set an absolute path.
- Each platform has its own definition of absolute, tested for both from any machine through
  `isExplicitAbsolutePath(value, flavor)`.
- Not checked: that the directory is writable or on a suitable filesystem; those surface at the first
  write.

## Alternatives considered

- Default to a per-user data directory (XDG, `%LOCALAPPDATA%`, `Application Support`): a silent
  default of the kind that hides a misconfiguration, and three platform conventions to maintain.
- Resolve a relative value against the user's home: surprising, and still not what the user wrote.
- Warn and continue: the files would already be in the project.
- Make the policy global: would break `ask` and `tools`, which have a working default.
