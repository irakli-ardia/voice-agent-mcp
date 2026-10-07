/** The Realtime API's `audio/pcm` output: mono, signed 16-bit little-endian, 24 000 Hz. */
export const PCM16_SAMPLE_RATE = 24_000;

const CHANNELS = 1;

const BYTES_PER_SAMPLE = 2;

/** The canonical PCM WAV header: `RIFF`, `WAVE`, a 16-byte `fmt ` chunk, and the `data` header. */
export const WAV_HEADER_BYTES = 44;

/** The largest data size whose RIFF chunk size (`36 + data`) still fits in 32 bits. */
const MAX_WAV_DATA_BYTES = 0xffff_ffff - 36;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

/**
 * A WAV file holding `chunks` as PCM: one allocation of exactly 44 + `byteLength` bytes and one
 * copy of each chunk. `byteLength` must be the chunks' total, a positive whole number of samples,
 * and small enough for the 32-bit RIFF sizes; anything else is a programming error and throws.
 */
export function pcm16Wav(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);

  if (
    total !== byteLength ||
    byteLength <= 0 ||
    byteLength % BYTES_PER_SAMPLE !== 0 ||
    byteLength > MAX_WAV_DATA_BYTES
  ) {
    throw new RangeError("PCM data must be a positive, whole number of 16-bit samples.");
  }

  const wav = new Uint8Array(WAV_HEADER_BYTES + byteLength);
  const view = new DataView(wav.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + byteLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, PCM16_SAMPLE_RATE, true);
  view.setUint32(28, PCM16_SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(32, CHANNELS * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BYTES_PER_SAMPLE * 8, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, byteLength, true);

  let offset = WAV_HEADER_BYTES;

  for (const chunk of chunks) {
    wav.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return wav;
}
