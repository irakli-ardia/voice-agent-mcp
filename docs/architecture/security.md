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

Confirmation is obtained outside the LLM — for the CLI, an explicit user prompt or token handled by
the host. The model cannot confirm its own destructive request. Until the host confirmation
channel exists (M6), the executor fails closed: every tool that requires confirmation is refused
with `confirmation_required`.

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
The guarantee is at most one note per key — never exactly-once delivery.

## Filesystem safety

Notes live only under the application-owned `DATA_DIR` (`<DATA_DIR>/notes/`), resolved to an
absolute path once at startup.

- **Names:** a note's file name is its id, the hex of a hash of the key, never text from a user or
  the model. `read_note` accepts only ids matching `^[0-9a-f]{32}$`, checked by the tool schema and
  again by the store before any path is built, so no input can name a path outside the directory.
- **Commit point:** a note is written to a temp file in the same directory, fsynced, then published
  with a hard `link` to its final name. The successful link is the only commit point; a failed link
  creates nothing, and `EEXIST` means another call already committed the key.
- **What is guaranteed** on a local filesystem with hard links (NTFS, ext4, tmpfs, APFS):
  - atomic publication — no reader ever sees a partial note;
  - concurrency — at most one note per key across concurrent calls and processes on one
    `DATA_DIR`, with no lock;
  - persistence across a process exit or crash once the link succeeded.
- **What is not guaranteed:** surviving an OS crash or power loss. The directory is never fsynced
  (Windows has no directory fsync), so an acknowledged note may vanish; a retry with the same key
  re-creates it, still at most one note.
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

Residual risk: there is no note-count or disk quota yet (M6). Each record is under 13 KB, but the
number of notes is unbounded across turns (and, from M5, over MCP). A full disk makes every create fail with
`storage_unavailable`, while reads keep working, and affects anything else under `DATA_DIR`.
Crashed writes can leave `.tmp-*` files behind; they are never read as notes.

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
over 10 s refused) ([agent loop](agent-loop.md#loop-protection)). Tool calls run one at a time, so
no concurrency bound is needed. `MAX_TOOL_RESULT_BYTES` caps the serialised result that leaves the
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
keys, the provider continuation (including encrypted reasoning), file paths, transcriptions, spoken
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
