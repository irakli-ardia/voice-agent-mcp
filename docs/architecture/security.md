# Security

Trust boundaries, action policy, and limits. The full threat model is `docs/threat-model.md`
(M6).

## The model is untrusted input

Never trust tool arguments because OpenAI returned them; never invoke a property or function named
by a model-supplied string; never let the model choose filesystem paths; never expose environment
variables; never run model-supplied shell commands; never deserialise unknown JSON into trusted
types; never leak internal errors or secrets into model context. MCP client input gets the same
treatment.

In the agent loop this means: function-call arguments are validated by the executor before any
handler runs, and undecodable arguments are rejected, never repaired; a model step with an invalid
or reused call id runs none of its calls; output items the adapter does not recognise, refusals,
and responses that did not complete are typed failures, never partly used; and the instructions tell
the model that tool output is data, never instructions — including note text the model itself
saved ([agent loop](agent-loop.md#turn)).

## Action policy

| Risk | Policy |
| --- | --- |
| `read` | Execute normally |
| `write` | May execute when user intent is explicit |
| `destructive` | Requires confirmation |
| `external` | Depends on irreversible effects; decided per tool |

### Confirmation

Confirmation is obtained outside the LLM. A tool opts in with `requiresConfirmation: true` in its
definition (a `destructive` tool cannot opt out); trusted application code decides that, and nothing
a caller sends can change it. No current tool requires it.

- **The gate:** the executor runs a tool that requires confirmation only if the `ToolCall` carries a
  `ConfirmationGrant` made for that very tool name and call id. The grant is a class instance with
  private state, checked with `instanceof`: text, JSON, a model's output, an MCP argument or `_meta`
  can never be one. Anything else, including no grant, a lookalike object, a grant that went through
  JSON, one for another tool or another call, or one already spent, is refused with
  `confirmation_required` and the same static message, before any handler, ledger entry, or side
  effect. The log says only `confirmation: "missing"` or `"rejected"`.
- **Single use, no ambient state:** the executor spends the grant when it admits the handler (after
  validation, the cancellation check, and the handler ledger), so an invalid, cancelled, or
  overloaded call does not use it up, and nothing else can: the second call with the same grant is
  refused. A grant that was spent on a call that then timed out is still spent; a retry needs a new
  grant. Nothing is stored in the executor or in a module.
- **Who can grant:** only code that holds the `ToolCall` it passes to the executor and constructs a
  `ConfirmationGrant` for it, in process. **Today no production host does:** the agent runner and the
  MCP adapter build every call from `id`, `name` and `arguments` alone and never read a grant from a
  model's output or a client request, so for them a tool that requires confirmation is always
  refused. The CLI has no prompt and MCP has no elicitation yet; either would be a small host that
  asks the user and then builds the call with a grant.
- **What it does not prove:** that a human was present. A host that issues a grant is trusted to
  have asked; the server cannot tell an attentive user from an auto-approving host. That is the stdio
  trust boundary, unchanged.

## Idempotency

A `timed_out` or `cancelled` result does not mean the handler stopped: its outcome is unknown, so a
retry after either must be safe to repeat ([tool system](tool-system.md#timeouts-and-cancellation)).
Every write tool therefore takes a required idempotency key, and a repeated key never repeats the
effect ([write tools](tool-system.md#write-tools-and-idempotency),
[decision 0008](../decisions/0008-idempotent-note-creation.md)). The model is not trusted to keep
a key across a retry: in the agent loop the host derives the key, the field is absent from the
model-facing schema, and a key the model sends anyway is replaced
([agent loop](agent-loop.md#arguments-and-host-owned-keys)).
An MCP client owns its key; if a client's model retries with a new key, a second note is created.
The guarantee is at most one note per key — never exactly-once delivery
([MCP server](#mcp-server)).

## MCP server

`voice-agent mcp` ([MCP](mcp.md)) exposes the same tools to a program the user chose to start. The
process that starts it is the trust boundary: there is no authentication and no network listener.
What the MCP client sends, and what its model decides, is untrusted input.

- **stdout is protocol-only.** Nothing but MCP messages is written to it; `console` is not used in
  `src`. Logs go to stderr as JSON lines. A line the SDK cannot parse is skipped silently.
- **Input validation:** the SDK checks the request envelope; the executor validates the arguments
  against the tool's strict Zod schema before any handler runs. A rejection names the property path
  and the rule, never the rejected value or an unknown property name.
- **Output validation and caps:** the executor validates each result against the output schema and
  caps its JSON at `MAX_TOOL_RESULT_BYTES`. A response carries the result twice (`structuredContent`
  and a text block built from the same object), so up to about twice the cap. The cap bounds what
  leaves the executor, not a handler's memory.
- **Exceptions are not logged.** A thrown value's message, stack, cause, and name never reach a log
  or a response; the log names a class from a fixed allowlist
  ([decision 0012](../decisions/0012-thrown-values-are-never-logged.md)). Arguments, results, note
  text, idempotency keys, paths, and JSON-RPC ids are never logged either.
- **Confirmation:** a tool that requires it is always refused over MCP (`confirmation_required`):
  a client cannot grant it by arguments, `_meta`, or anything else, and there is no elicitation yet
  ([Confirmation](#confirmation)). No current tool requires it.
- **Idempotency keys belong to the caller.** The server never generates or rewrites one. A client
  that retries a write after an unknown outcome must reuse its key; a fresh key creates a second
  note.
- **Inbound size:** one message may be at most 1 MiB (fixed). A larger one stops the server with
  exit 1; the process does not hang, and stdout stays empty.
- **Rate:** `MCP_MAX_CALLS_PER_SECOND` (default 20, 1–1000) is a token bucket on `tools/call` for
  the whole process: a call without a token gets `rate_limited` before any handler runs
  ([MCP](mcp.md#rate-limit)). It bounds the work done, not what a client may send.
- **Output backpressure:** a client that stops reading answers makes the server stop reading
  requests once 64 KiB of output is queued (a pause threshold, not a limit: the answers to the read
  that crossed it are still queued, measured at most 6.7 MB). The queue itself has an enforced
  maximum, 33 MiB by default; past it the connection fails rather than grow
  ([MCP](mcp.md#stdio-and-the-process)). A stop signal while the client is not reading
  ends the process after at most about 2.5 seconds, and the answers still queued are not delivered
  (logged, with counts: [shutdown](mcp.md#shutdown)).
- **Concurrency:** `MCP_MAX_IN_FLIGHT_CALLS` (default 16, 1–128) bounds the calls executing at once;
  the next gets `server_busy` before any handler runs. It is a concurrency cap, and it
  stops counting a call when the executor stops waiting. A handler that outlives a cancellation or
  a timeout is then counted by the executor's handler ledger: once `MAX_ABANDONED_TOOL_HANDLERS`
  (default 3, 1–64) are still running, new calls are refused with `overloaded` before any handler
  runs ([tool system](tool-system.md#unsettled-handlers)).
- **Cancellation and unknown outcomes:** a cancel, or closing stdin, makes the executor stop waiting
  and the SDK send no response. It does not stop or undo a handler that ignores its signal, such as a
  write past its commit point: the outcome is unknown to the client, and `tool.settled_late` records
  a late completion. Nothing claims a cancelled write was rolled back. Retry with the same key.
- **Duplicate JSON-RPC ids:** a client that reuses an id still in flight (forbidden by the protocol)
  gets both requests run and both answered under that id, and a cancellation for it reaches only the
  later one. The SDK offers no safe way to reject the duplicate. Validation, idempotency, the
  in-flight limit, and the output cap still apply to each.
- **Filesystem:** the notes are the same file-backed store as the CLI ([filesystem safety](#filesystem-safety)).
  Set `DATA_DIR` to an absolute path. `MAX_NOTES` bounds the notes across every process that
  shares it ([note quota](#note-quota)).

Not hardened yet (M6): an interactive confirmation flow (the gate exists; no host uses it), a threat
model, and shutdown tests for the whole process. This is a working, tested boundary, not a fully
hardened one.

## Filesystem safety

Notes live only under the application-owned `DATA_DIR`: the notes in `<DATA_DIR>/notes/` and their
quota slots in `<DATA_DIR>/note-slots/`, resolved to an absolute path once at startup. The MCP
server will not start without an explicit absolute `DATA_DIR`, so a host cannot make it write into
its own working directory by accident ([MCP](mcp.md#data_dir)). Both must be
on one local filesystem with hard links.

- **Names:** a note's file name is its id, the hex of a hash of the key, never text from a user or
  the model. `read_note` accepts only ids matching `^[0-9a-f]{32}$`, checked by the tool schema and
  again by the store before any path is built, so no input can name a path outside the directory.
- **Steps, in order:**
  1. *Record preparation:* the note is written to a temp file in the same directory and fsynced.
  2. *Quota reservation:* the call claims a **slot** (below) by linking that complete file into it.
     This reserves capacity and leaves a durable record of intent; it is not yet a note. Before it
     nothing is visible and an abort stops the call; after it the call finishes whatever the signal says.
  3. *Publication:* the call links the file to the note's final name. This exclusive `link` is the
     **commit point**: the moment the note exists, and the one the replays and conflicting replays of
     a key all agree on (`EEXIST` means another call published the key first). A failed link
     creates nothing. Recovery may perform this step for a call (it links the same file), and the
     call then finds its note there.
  4. *Response:* only after publication returns does the call report `created`. A call that dies
     between steps 3 and 4 leaves a note whose caller never heard back; the retry replays it.
- **What is guaranteed** on a local filesystem with hard links (NTFS, ext4, tmpfs, APFS):
  - atomic publication: no reader ever sees a partial note;
  - concurrency: at most one note per key, and at most `MAX_NOTES` notes in all, across concurrent
    calls and processes on one `DATA_DIR`, with no lock;
  - survival of a **process crash** at any step: a crash before the claim leaves nothing but a
    temp file; one after it leaves a slot holding the complete record, which recovery publishes or
    frees; one after publication leaves the note, which the retry replays.
- **What is not guaranteed:** surviving an OS crash or power loss. File contents are fsynced but
  directories never are (Windows has no directory fsync), so after a power loss an acknowledged
  note, its slot record, or both links may be missing independently of each other. A note that
  lost its slot record is given a slot again when the store is next reconciled, if one is free; on a
  full store it may stay without one, so the count can then exceed `MAX_NOTES` by those notes. A
  retry with the same key re-creates a vanished note, still at most one per key.
- **Unsupported:** network filesystems, and filesystems without hard links (FAT32, exFAT), where
  every create fails safe with `storage_unavailable`.
- **Reads are untrusted:** a record over 64 KiB is refused unread; bytes must be UTF-8 JSON matching
  a strict schema whose id matches the file name and whose key matches the request (or hashes to
  the id). Anything else is reported `note_unreadable`, never returned, and left in place.
- **Permissions:** the directory is created `0o700` and note files `0o600` (POSIX; Windows uses
  the parent's ACLs).
- **Errors:** a filesystem error never leaves the store. It is logged as a phase and a system error
  code (`ENOENT`), never a message, because messages contain absolute paths; the caller gets a
  static message.

### Note quota

`MAX_NOTES` (default 10 000, 1 to 1 000 000) bounds the number of notes. A **slot** is a directory
`note-slots/<index>/`, for an index below `MAX_NOTES`, holding one record: a hard link to the complete
note file, under a unique name. A claim is prepared privately, as a directory outside the slots that
already holds the record, and becomes slot `<index>` in one atomic `rename`, which fails if that slot
exists. However many writers and processes race, at most `MAX_NOTES` slot directories exist, a slot
never exists without its record, and a note is only ever published from a slot: **the store never
holds more than `MAX_NOTES` notes**, with no in-memory counter and no lock. A note's slot is the
record that is the same file as the note.

The one rule that keeps it so: **a record that might still be published is never removed.** The only
removals are of a record whose note exists and is a different file (it can never be published, so it
is surplus), and of a claim that never became a slot. A failed write therefore leaves its record where
it is; it is never released "just in case". Because no record that backs a note, or may come to, is
ever removed, no race between a writer, a recovery, and a stalled process can leave a note without
its slot ([decision 0013](../decisions/0013-note-quota-slots.md)).

- **Over the quota** a new key fails with `note_quota_exceeded`, a static message with no path or
  text. Nothing is written for it. The refusal is logged as `note_store.quota_exceeded` with the limit.
- **Replays never need a slot:** a key whose note exists returns that note (or the stored note, for a
  conflicting replay), however full the store is. A normal write does no directory scan: the slots
  are looked at once per process, and again only when a create finds the store full.
- **A write that loses the race to publish** (its link finds the note) frees its own slot at once,
  after checking that the note is not its own file. **A write whose link fails for any other reason**
  reports `storage_unavailable` and keeps its slot: the outcome is unknown, as it is for a crash at
  that point, because recovery may publish the record later. Retrying with the same key is safe and
  converges: the retry publishes or replays, and the stale record is freed as surplus.
- **Recovery never decides a writer is dead.** It only completes: a slot with no note, once ten minutes
  old, is published from by linking that very file to the note's name (exclusive, so at most once),
  and the slot stays as the note's backing. Age only spares a running write needless work; a live
  writer's own link finds the note already there, recognises it as the same file, and reports
  `created`. A retry meanwhile may claim a second slot for the same key; the one that is not the
  note is surplus and is freed. An empty slot directory (all a release interrupted at its last step
  leaves) is removed. A claim that was being prepared when its writer died takes no slot and publishes
  nothing; it is removed once an hour old. Recovery runs the first time a store is used without its
  ready marker and whenever a create finds the store full (at most once in ten seconds per process);
  it is safe to repeat, to interrupt, and to run in several processes at once.
- **Deletions cannot hit a newer claim:** a record is removed by its unique name, and a slot directory
  only when empty, and only by the call that removed its record.
- **Stores from before slots** are accounted for, not migrated: each old note is hard-linked into a
  slot, never changed or copied. Old notes beyond a lowered `MAX_NOTES` stay readable; the store takes
  no new notes until it is below the limit. A note that is not a valid record (corrupt) still has its
  slot like any other, and keeps it; it is never given a second one. A store used by an older version
  at the same time is not supported.

Assumptions: notes and slots on one local filesystem with atomic exclusive `link`, and an atomic
`rename` of a directory that fails when its target is a directory with something in it (on Windows,
when it exists at all; on POSIX, an empty target is replaced, which is a free slot). Nothing relies on
file locks, process ids, or clocks agreeing between processes (clocks are only compared with file
times, to decide when recovery may start work, never to decide who owns what).

Known limits: quota refusal can be momentary, because racing creates of one key briefly hold a slot
each, and a refused call may succeed on retry. A `storage_unavailable` from a failed link may be
followed by the note appearing later (see above); a persistently failing link leaves one slot per
attempt until recovery can publish or free them. After a power loss the slot and the note are not
guaranteed to survive together (see above). On Windows an empty slot directory blocks its index until
recovery removes it.

### Temp files

Crashed writes can leave `.tmp-<uuid>` files in the notes directory; they are never read as notes. When a
store is first used, files named exactly like that, that are regular files (never a link, a
directory, or anything else) and at least an hour old, are removed. Age is not proof that a writer is
dead, so this is safe by construction: a live write whose temp file is removed fails before it
publishes (`storage_unavailable`, nothing published, its slot freed, retry is safe), and a temp file
that is already a note's or a slot's record is only another name for it. Nothing outside the notes directory is listed or removed.

### What reads and creates refuse

A note path that is a symbolic link, a FIFO, or anything but a regular file is not read: the file is
opened without following links and without blocking, and its type is checked on the open handle.
The slot directory must be a real directory, not a link.

A full disk makes every create fail with `storage_unavailable`, while reads keep working, and
affects anything else under `DATA_DIR`.

## Audio input

`ask --audio <file>` reads a file the CLI user named; the model and tool calls never choose a path.

- **Judged by the open file, not the path:** the file is opened read-only (non-blocking on POSIX,
  so a FIFO cannot stall the open), and the open handle must be a regular file. Directories,
  devices (`/dev/zero`, `\\.\NUL`), FIFOs, and sockets are refused. Symlinks are followed: the path
  is the user's own.
- **Bounded:** at most 8 MiB, read in chunks, never more than the limit plus one byte, even if the
  file grows or reports a wrong size. The handle is closed on every path.
- **Checked before upload:** the bytes must start like WAV, MP3, MP4/M4A, or WebM audio; anything
  else (a `.env`, a document, a renamed file) fails `audio_unsupported` and is never sent. The upload
  is named `audio.<format>`; the user's file name and path never leave the machine. Embedded
  metadata in an accepted file (ID3 tags, MP4 atoms) is sent as is.
- **Not guaranteed:** a duration limit. There is no local decoder, so a highly compressed 8 MiB file
  can hold hours of audio, billed by the minute.

## Speech files

`--speech-out <file.wav>` names a file the CLI user wants created.

- **Reserved before any spend:** the file is created exclusively (`wx`) before transcription, the
  agent turn, or speech, so an existing name fails `speech_output_exists` before anything is paid
  for. It is never overwritten. Parent directories are never created. The name must end in `.wav`
  and must not contain `:` (a Windows alternate data stream).
- **Symlinks:** any existing entry at the path, including a dangling symlink, is refused first.
  This matters on Windows, where an exclusive create follows a dangling symlink and creates its
  target (POSIX `O_EXCL` does not). A symlink created in the instant between that check and the
  create is caught by the next point.
- **Ownership:** after creating the file the adapter records its identity (device and inode) and
  proves the path names that very file; a regular file is required (Windows device names are
  refused). It removes a file only if the path still names that identity, never merely because
  something exists at the name.
- **Commit point:** write all bytes, fsync, close. A failed write, fsync, or close is never reported
  as saved. Before the commit point any failure or cancellation removes the file; after it, the
  file stands.
- **Permissions:** created `0o600` on POSIX; Windows applies the parent directory's ACLs.
- **Residual risks:**
  - Between the final identity check and the unlink there is a short window in which another local
    process with write access to that directory could swap in a different file, which would then be
    removed. No portable Node API closes it.
  - The file is visible (empty, then growing) while the speech is produced, and a hard kill (a
    second Ctrl+C, a crash) can leave an empty or partial file. Surviving an OS crash or power loss
    is not guaranteed for the directory entry.

## The speech renderer

The Realtime model that speaks the answer is treated as untrusted output, like any provider.

- It receives the final answer as JSON data with fixed instructions, no tools, and audio-only
  output. Answer text that looks like instructions ("ignore all previous instructions...") stays
  data.
- Every server event it sends is validated; anything that is not exactly one assistant audio
  message for the one requested response (a tool call, text output, a second response, malformed
  audio) fails the rendering.
- Its report of what it spoke must match the answer word for word (no fuzzy or semantic matching);
  otherwise `synthesis_unfaithful` and nothing is saved. That transcript is the provider's own
  report, not an independent recognition of the audio: live verification also transcribed the
  rendered audio, but the product check relies on the provider's report.
- The answer is already on stdout when speech starts; a speech failure never hides or changes it
  ([audio pipeline](audio-pipeline.md)).

## Denial and cost controls

Built: user text length (`MAX_INPUT_TEXT_CHARS`), model invocations per turn
(`MAX_AGENT_ITERATIONS`), tool calls per turn (`MAX_TOOL_CALLS_PER_TURN`, checked per response
before any call runs), a turn deadline (`AGENT_TURN_TIMEOUT_MS`), a per-attempt provider timeout,
output tokens per model invocation, and bounded retries (at most `OPENAI_MAX_RETRIES`, server waits
over 10 s refused) ([agent loop](agent-loop.md#loop-protection)). In the agent loop tool calls run one at a time;
over MCP they run concurrently under `MCP_MAX_IN_FLIGHT_CALLS` ([MCP server](#mcp-server)); handlers that outlive a cancellation or timeout are bounded by `MAX_ABANDONED_TOOL_HANDLERS`. `MAX_TOOL_RESULT_BYTES` caps the serialised result that leaves the
tool executor; it does not limit a handler's memory or CPU
([tool system](tool-system.md#result-size-cap)). Speech: audio input at most 8 MiB, spoken answers
at most 800 characters, a speech deadline per transcription and per rendering
(`SPEECH_TIMEOUT_MS`), at most 9 600 000 PCM bytes and 4096 output tokens per rendering, and no
retry once a rendering was requested.

## Secrets and logging privacy

API keys never in logs, docs, or committed files (`.env` is git-ignored; `.env.example` holds
placeholders only). `OPENAI_API_KEY` is read only by the command that calls OpenAI (`ask`), never
kept in the application config, and never echoed: a missing key is reported by name. Provider error
bodies and messages never leave the OpenAI adapter; it logs an HTTP status and a sanitised error
code. Nothing logs user text, assistant text, tool arguments or results, note text, idempotency
keys, the message, stack, cause, or name of a thrown value, JSON-RPC request ids, the provider continuation (including encrypted reasoning), file paths, transcriptions, spoken
text, audio bytes, Realtime event payloads, or secrets; the logger
also redacts known secret fields (`src/adapters/logging/pino-logger.ts`)
([observability](observability.md)).

## Model requests and provider data

Requests are stateless with `store: false`
([decision 0009](../decisions/0009-stateless-agent-loop.md)). That means the application does not
store response state at the provider for later retrieval; it is not, by itself, zero data retention
— the provider's own retention policies still apply. Each request contains the turn's user text,
tool arguments and results (which can include note text), and the encrypted reasoning items the
provider returned. With speech, the audio file (including any embedded metadata) goes to the
transcription endpoint, and the final answer goes to the Realtime API to be spoken.

The OpenAI client is built with every environment-backed option set explicitly
(`src/adapters/openai/openai-client.ts`): the API key, a fixed `https://api.openai.com/v1` base URL,
`null` organisation, project, admin key, and webhook secret, logging off, and SDK retries off. So
`OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `OPENAI_ADMIN_KEY`,
`OPENAI_WEBHOOK_SECRET`, and `OPENAI_LOG` in the environment have no effect. Known residual: the SDK
merges headers from `OPENAI_CUSTOM_HEADERS` into every request, and no supported option turns that
off; whoever controls the process environment can add headers to the application's OpenAI
requests (but cannot redirect them or read the responses through this). The speech renderer does
not use the SDK client: it opens `wss://api.openai.com/v1/realtime` itself with the key in an
`Authorization` header (never in the URL or a WebSocket subprotocol), so that residual does not
apply to it.

## Dependency security

Committed lockfile, Dependabot, CodeQL (M6), `npm audit` as an informative check, minimal
dependency count, no abandoned convenience packages without justification.
