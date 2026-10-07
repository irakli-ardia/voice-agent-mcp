# 0010 — Speech pipeline around the text agent, with a Realtime renderer

Status: accepted — 2026-10-07

## Context

M4 adds speech: an audio file in, the answer spoken into a file out. The agent loop, the tool
system, and the safety rules around them (validation, policy, host-owned idempotency, bounded
turns) already work for text, and speech must not weaken or duplicate any of them. OpenAI is
retiring every model of its classic speech endpoint (`/v1/audio/speech`, removal announced for
2027-01-06) in favour of the Realtime API, whose models are conversational: given text, they could
answer it instead of reading it.

## Decision

- **Speech wraps the unchanged agent.** Audio is transcribed into the turn's user text; the answer
  is spoken after the turn. The agent runner, the tools, and the executor know nothing about audio.
  The CLI sequences the stages; each is an application service behind a port (`SpeechToText`,
  `TextToSpeech`, `AudioFiles`), and every provider type stays in its adapter.
- **Speech-to-text:** `gpt-transcribe` file transcription, the model OpenAI recommends; the older
  transcription models are scheduled for removal. Only the model and the file are sent; the upload
  is named `audio.<format>`, never the user's file name.
- **Input contract:** WAV, MP3, MP4/M4A, and WebM, recognised from the bytes before upload, at most
  8 MiB — an application limit for spoken requests, well below the provider's 25 MB, because bytes
  are the only bound available without decoding audio locally.
- **Speech output:** `gpt-realtime-2.1-mini` over the Realtime API on a WebSocket, voice `marin`, as
  a renderer, not an agent: a fresh connection and one out-of-band response per answer, no tools,
  audio-only output, the answer sent as JSON data with fixed instructions, minimal reasoning,
  `max_output_tokens` 4096. Node's built-in `WebSocket` with an `Authorization` header — no
  dependency, and no API key in a browser-style subprotocol.
- **Strict fidelity gate.** The provider's report of what it spoke must equal the answer word for
  word after only representation-level normalisation (NFKC, case, everything between words);
  otherwise the speech is not saved. No fuzzy, semantic, edit-distance, or model-judged matching:
  any of those would let a renderer that rephrases, adds, or answers pass, and the point of the gate
  is that the agent alone decides content.
- **Format and limits:** the renderer's PCM (16-bit little-endian, mono, 24 kHz) is wrapped in a
  44-byte WAV header — no transcoding. Spoken answers at most 800 characters (about 45 s of speech at
  the measured rate); a defensive cap of 9 600 000 PCM bytes (200 s) per rendering.
- **The application owns time.** One speech deadline per transcription and per rendering
  (`SPEECH_TIMEOUT_MS`, default 180 s), separate from the turn deadline, plus the caller's
  cancellation; adapters add no whole-operation timeout of their own. Rendering is never retried
  once requested, so it is never paid for twice; only failures before the request are retried.
- **The answer is never hidden (D1).** It is printed when the turn ends; a later speech failure adds
  one error line on stderr and a non-zero exit code, and the answer stays on stdout.
- **Reserve before spending (D2).** The output file is created exclusively before any provider is
  used, never overwritten, owned by its identity, and removed unless committed.
- **No process-exit guard.** Node's `WebSocket` waits for the server to end TCP after a close. A
  local server that never does keeps the process alive, but measured against the real API the
  process exits on its own about 2 s after the rendering settles, so no guard was added.

## Consequences

- Speech adds stages around the turn but no new path through the agent or the tools; text-only
  commands compose no speech code at all.
- The fidelity gate fails closed: a rendering that differs in wording — including a number spoken
  as words where the answer has digits — is not saved. That trades occasional false rejections for
  never saving speech that says something the agent did not.
- The renderer's transcript is the provider's own report. Live verification (fixed, adversarial
  sentences rendered and then transcribed back) supported using the Realtime model this way, but the
  check in production relies on that report.
- Byte limits do not bound audio duration on input; the provider's per-minute billing for a highly
  compressed file is a documented residual risk.
- Speech output depends on a Realtime model family; when OpenAI renames or retires it, the change
  is confined to one adapter and its configuration.

## Alternatives considered

- **`gpt-4o-mini-tts` on `/v1/audio/speech`** — exact text-to-speech, but scheduled for removal.
- **Speech-to-text only** — kept as the fallback had the renderer failed the fidelity gate.
- **A combined voice agent (Realtime speech-to-speech)** — would replace the audited text agent
  and its tool controls with a second one.
- **Transcoding to MP3** — needs ffmpeg or an encoder dependency for no safety gain.
- **Microphone capture and playback** — native audio devices and per-platform packages, for a CLI
  that works on files; left for later.
