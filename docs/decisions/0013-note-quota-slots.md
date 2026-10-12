# 0013 — Note quota by exclusive slot claims

Status: accepted — 2026-10-11

## Context

Notes are files, so their number is bounded only by the disk, and several processes (the CLI, an MCP
server, more than one MCP host) share one `DATA_DIR`. A quota must hold across all of them, with no
lock and no counter that can disagree, must not refuse a replay of a note that already exists, and
must survive a process dying at any step without losing capacity for good.

## Decision

`MAX_NOTES` slots, each a **directory** `note-slots/<index>/` holding one record: a hard link, under a
unique name, to the complete note file. A claim is prepared privately (a directory outside the slots
that already holds the record) and becomes slot `<index>` by one atomic directory `rename`, which fails
if the slot exists. A note is published only from a slot, so the number of notes never exceeds the
number of slots. Claiming the slot is the quota reservation and a durable record of intent; the note
exists when the same file is linked to its final name (publication, the commit point), by the writer or
by recovery.

- **A record that might still be published is never removed.** Removals: a record whose note exists
  and is a different file (permanently surplus); a claim that never became a slot. A write whose link
  fails for a reason other than "the note exists" keeps its record and reports an unknown outcome.
  This is what makes a note without its slot impossible: nothing that backs a note, or may come to,
  can be removed by anyone, so no interleaving of writer, recovery and stalled process matters.
- Recovery needs no liveness check and takes nothing over: it completes what a writer was about to
  do, linking the same file to the note's name (exclusive). A live writer finds its note and reports
  `created`. Old slots without a note are published from; a note's slot is the record that is the same
  file as the note.
- Every deletion is by a record's unique name, or an `rmdir` that only works on an empty directory,
  and only by the call that removed the record.
- A note whose slot record is unreadable still has that slot; it is never given another.
- Replays are checked before anything else and never take a slot.
- Notes from before slots are linked into slots, never copied or moved.

## Consequences

- The bound is exact and lock-free; a crash at any point loses nothing but a temp file or a claim
  being prepared, both removed once old.
- A write costs a `mkdir`, a `link` and a `rename` more, and a probe; no scan.
- Two designs were discarded after real-process tests and the S3 audit. A slot as a file freed by
  index: a late release could delete a slot freed and claimed again (eleven notes, ten slots). A slot
  as a directory made by `mkdir` and filled by `link`: a directory removed and made again under a
  stalled claimer could hold two records, and a failed write releasing its record could race with
  recovery publishing from it, leaving a note with no slot (two notes, one slot, reproduced
  deterministically). Both came from a window between making the claim and completing it, and from
  removing a record that could still be published; neither can happen now.
- Slots and notes must share a filesystem with hard links, as they already must.
- Racing creates of one key can briefly make a store look full: a refusal that a retry resolves.
- A failed link leaves a pending record, so its outcome is unknown to the caller.

## Alternatives considered

- An in-memory counter, with or without a recount at the boundary: exact only inside one process.
- A directory listing before each write: a race between the listing and the write.
- Empty slot files claimed by exclusive create, freed by age or by process id: age is not proof that
  a writer is dead, and a process id is not stable proof either.
- Taking a record over by renaming it before publishing from it, so the writer could not remove it:
  concurrent renames of one name all succeed on Windows, so it is not exclusive there.
- Exclusive decision markers per record, to arbitrate writer release against recovery: correct, but a
  second protocol; not removing a record that might be published removes the need.
- A database (SQLite): transactions would settle all of this, but the built-in module is experimental
  on the supported Node versions, and a dependency is not justified by one counter.
- A lock file around count-and-write: needs stale-lock handling, and blocks other processes.
