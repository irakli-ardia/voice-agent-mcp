# Audio pipeline

Speech-to-text in, text-to-speech out, both behind ports. Status: planned (M4).

## Speech-to-text (`SpeechToText` port)

The OpenAI adapter (`src/adapters/openai/openai-stt.ts`):

- validates file type and size (`MAX_AUDIO_BYTES`) before the provider call;
- uses the configured transcription model and an optional language hint;
- honours timeout and cancellation;
- normalises the provider response into a canonical transcript result;
- maps errors safely and records timing.

`src/app/audio/transcribe-audio.ts` knows nothing about OpenAI response types.

## Text-to-speech (`TextToSpeech` port)

The OpenAI adapter (`src/adapters/openai/openai-tts.ts`): configured model, voice, and output
format (low latency by default), timeout and cancellation, bounded input length, binary response
handling, provider error mapping.

Output is saved to `.data/output/<turn-id>.<ext>` (format decided in M4). Playback is an
optional separate adapter so generation stays independent of OS-specific playback.

## Input modes

- Phase 1: `voice-agent ask --audio <path>` (file input).
- Phase 2 (optional): `voice-agent listen` from a microphone — only if it can be done portably
  without destabilising native dependencies (open question).

## Resource discipline

No raw audio in logs. Never read unbounded files or copy large buffers unnecessarily. Track
transcription, TTS, and total turn latency ([observability](observability.md)).
