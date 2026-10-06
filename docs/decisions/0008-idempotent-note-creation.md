# 0008 — Idempotent note creation: required key, key-derived id, hard-link publication

Status: accepted — 2026-10-06

## Context

The executor's `timed_out` and `cancelled` mean "outcome unknown": JavaScript cannot stop a handler
that ignores its signal, so a write may still commit after the caller gave up. A caller that retries
must not create a second note. A model is not a reliable transaction coordinator: after an unknown
outcome it may retry with a new key or none. The note store may be shared by several processes (the
CLI and an MCP server on one `DATA_DIR`), and its files are read back as untrusted input.

## Decision

- `create_note` requires an `idempotencyKey` (16–64 of `[A-Za-z0-9_-]`); there is no keyless write.
  The key belongs to the caller of the executor. In the agent loop that caller is the host, which
  derives the key from the turn, the tool, and its arguments; the model never sees it. MCP clients
  own their keys.
- One key names one note: `noteId` is the lowercase hex of the first 16 bytes of SHA-256 over the
  key's UTF-8 bytes. Same key + same text replays the original note (`created: false`); same key +
  different text is the declared failure `idempotency_key_conflict`; different keys create
  different notes. The scope is the whole store; a key lives as long as its note.
- Each note is one immutable JSON file, `<DATA_DIR>/notes/<noteId>.json`, holding the full key.
  It is published by writing and fsyncing a temp file in the same directory, then `link`ing it to
  the note's name. The successful link is the only commit point. A link that fails with `EEXIST`
  means another call committed the key; the store reads and validates that record.

## Consequences

- At most one note per key, across concurrent calls and processes, with no lock: `link` is atomic
  and exclusive, and a failed `link` creates nothing.
- No reader ever sees a partial note. A note survives a process exit or crash once the link
  succeeded. It is **not** guaranteed to survive an OS crash or power loss: the directory is never
  fsynced (Windows has no directory fsync), so an acknowledged note may vanish; a retry with the
  same key re-creates it.
- `DATA_DIR` must be on a local filesystem with hard links (NTFS, ext4, tmpfs, APFS). On FAT32,
  exFAT, or a network filesystem every create fails safe with `storage_unavailable`.
- Records are validated on read (size cap, UTF-8, schema, id and key match); a bad record is
  reported `unreadable`, never returned, and blocks its key until an operator fixes it.
- A truncated-hash collision is reported `unreadable`, never mixed with another key's note,
  because the stored key is compared in full.
- Identical writes inside one agent turn are one operation, by design of the host-derived key.

## Alternatives considered

- Optional key, or the transport's tool-call id as key — a model's retry is a new call with a new
  id; MCP JSON-RPC ids repeat across sessions. Neither protects the timeout retry.
- `rename(temp, final)` — replaces an existing file on both POSIX and Windows: not exclusive.
- `writeFile(final, { flag: "wx" })` or `copyFile` with `COPYFILE_EXCL` — exclusive, but content
  is visible while being written; a crash leaves a truncated file that blocks its key.
- A key index or lock file beside each note — two steps, needs crash recovery and stale-lock rules.
- `node:sqlite` — experimental on Node 22, and a database the scope does not otherwise need.
