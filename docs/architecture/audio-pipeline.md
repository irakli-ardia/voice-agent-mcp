# Audio pipeline

Speech in and speech out around the unchanged text agent. Status: built (M4).
Why it is shaped this way: [decision 0010](../decisions/0010-speech-pipeline-around-the-text-agent.md).

```
ask --audio a.wav --speech-out r.wav
  1. reserve r.wav          exclusive create, before any provider is used
  2. transcribe a.wav       bounded local read → format check → OpenAI speech-to-text
  3. agent turn             the same AgentRunner and tools as ask --text
  4. stdout                 the answer, once, with one newline
  5. speak the answer       OpenAI Realtime renderer → fidelity check → WAV → commit r.wav
```

Each stage is optional except the turn: `--text` replaces 1–2's input, and without `--speech-out`
there is no 1 or 5. The agent runner and the tools know nothing about audio.

## Components

| Part | Path | Role |
| --- | --- | --- |
| `SpeechToText` port | `src/ports/speech-to-text.ts` | Audio bytes and their format in, text out |
| `TextToSpeech` port | `src/ports/text-to-speech.ts` | Text in; a WAV and the provider's spoken text out |
| `AudioFiles` port | `src/ports/audio-files.ts` | Bounded reads; exclusive output reservations |
| Transcription service | `src/app/audio/transcribe-audio.ts` | Read → format → transcribe → validate, under the speech deadline |
| Speech output service | `src/app/audio/speech-output.ts` | Reserve → render → fidelity check → commit, under the speech deadline |
| Fidelity check | `src/app/audio/spoken-text-matches.ts` | Strict word-for-word comparison of the answer and the spoken text |
| Format detection | `src/domain/audio-format.ts` | Recognises accepted formats from the bytes |
| OpenAI STT adapter | `src/adapters/openai/openai-speech-to-text.ts` | `gpt-transcribe` file transcription |
| Realtime renderer | `src/adapters/openai/realtime-text-to-speech.ts` | `gpt-realtime-2.1-mini` over a WebSocket |
| WAV writer | `src/adapters/openai/pcm16-wav.ts` | 44-byte header around the PCM |
| Local audio files | `src/adapters/persistence/local-audio-files.ts` | The only code that touches audio files |

## Input

- **Formats** (recognised from the content, never the file name): WAV (`RIFF`/`WAVE`), MP3 (MPEG
  audio Layer III, optionally after an ID3v2 tag), MP4/M4A (`ftyp` with an audio-capable brand), and
  WebM (EBML with DocType `webm`). This is the set the OpenAI speech-to-text guide lists, and our
  own contract: other formats the API may accept (FLAC, Ogg) are deliberately not accepted here.
  Anything else fails `audio_unsupported` before any upload.
- **Size:** at most 8 MiB, read in bounded chunks from the opened file, never past the limit. Bytes
  do not bound duration: a very low-bitrate file can hold far more audio than a spoken request.
- **Upload:** the bytes go to OpenAI as `audio.<format>` with a fixed media type; the user's file
  name and path are never sent. The request carries the model and the file only.
- **Transcription:** blank text fails `transcription_empty`; text over `MAX_INPUT_TEXT_CHARS`
  fails `transcription_too_long`. Otherwise it becomes the turn's user text, unchanged.

## Output

- **Renderer, not agent.** The final answer is sent to the Realtime API as data in a JSON envelope
  (`{"text_to_speak": …, "require_repeat_verbatim": true}`) with fixed renderer instructions, no
  tools (`tools: []`, `tool_choice: "none"`), audio-only output, an out-of-band response
  (`conversation: "none"`), minimal reasoning, and `max_output_tokens` 4096. One fresh connection
  and one response per answer.
- **Fidelity.** The provider reports the text it spoke. It must equal the answer word for word after
  removing only representation-level differences: Unicode compatibility forms (NFKC), letter case,
  and everything between words. Digits stay digits ("42" ≠ "forty-two"). A mismatch is
  `synthesis_unfaithful` and nothing is saved.
- **Format:** the Realtime output is mono, signed 16-bit little-endian PCM at 24 kHz. It is wrapped
  in a standard 44-byte WAV header: no transcoding, no audio library. `--speech-out` must name a
  `.wav` file.
- **Limits:** answers over 800 characters are not spoken (`synthesis_text_too_long`); a rendering
  over 9 600 000 PCM bytes (200 s) is cancelled as a protocol error.
- **The file:** created exclusively before anything is spent, never overwritten, never in a
  directory that does not exist; committed by write, fsync, and close; removed on every failure
  ([filesystem safety](security.md#speech-files)).

The voice is AI-generated (OpenAI text-to-speech), not a human voice. Whoever plays the file to
other people must tell them so.

## Deadlines, retries, and cancellation

- **Speech deadline** (`SPEECH_TIMEOUT_MS`, default 180 s): one budget per transcription and one
  per rendering, covering file steps, every attempt, retry waits, and every byte received. It is
  separate from the agent's turn deadline.
- **Retries:** speech-to-text retries transient failures (connection, timeout, 408, 409, 429 except
  quota, 5xx) up to `OPENAI_MAX_RETRIES`. The renderer retries only before it has asked for a
  rendering (connection failures, server errors before `response.create`); once a rendering was
  requested it is never retried, so a rendering is never paid for twice.
- **Cancellation** (first Ctrl+C): stops whichever stage is running; an unfinished rendering is
  cancelled with `response.cancel`, and the socket is closed without waiting for the close
  handshake. Before the commit point the output file is removed; after it, the file stands.

## Out of scope

No microphone capture and no playback in M4: both depend on native audio devices and per-platform
packages, which the file-based CLI does not need.
