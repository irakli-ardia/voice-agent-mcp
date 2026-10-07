/** Builds the first bytes of audio files, so format tests need no binary fixtures in the repo. */

export function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

/** `parts` concatenated, then zero-padded to at least `length` bytes. */
export function audioBytes(parts: readonly number[], length = parts.length): Uint8Array {
  const bytes = new Uint8Array(Math.max(length, parts.length));

  bytes.set(parts);

  return bytes;
}

/** `RIFF`, a size, and `WAVE`: the 12 bytes that identify a WAV file. */
export const WAV_HEADER: readonly number[] = [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WAVE")];

/** An MPEG-1 Layer III frame header: 128 kbit/s, 44.1 kHz. */
export const MP3_FRAME: readonly number[] = [0xff, 0xfb, 0x90, 0x64];

/** An ID3v2 tag header for a tag body of `size` bytes, followed by that many zero bytes. */
export function id3Tag(size: number, majorVersion = 3, flags = 0): number[] {
  const synchsafe = [21, 14, 7, 0].map((shift) => (size >> shift) & 0x7f);

  return [
    ...ascii("ID3"),
    majorVersion,
    0,
    flags,
    ...synchsafe,
    ...new Array<number>(size).fill(0),
  ];
}

/** An `ftyp` box of `boxSize` bytes with `brand` as the major brand. */
export function ftypBox(brand: string, boxSize = 24): number[] {
  const size = [24, 16, 8, 0].map((shift) => (boxSize >>> shift) & 0xff);

  return [...size, ...ascii("ftyp"), ...ascii(brand), 0, 0, 0, 0];
}

/** Bytes written as hex pairs; spaces only group them for reading. */
function hex(text: string): number[] {
  return (text.match(/[0-9a-f]{2}/g) ?? []).map((pair) => Number.parseInt(pair, 16));
}

/** The EBML header a browser `MediaRecorder` writes for WebM (DocType `webm`). */
export const WEBM_HEADER: readonly number[] = [
  ...hex("1a45dfa3 9f 4286 81 01 42f7 81 01 42f2 81 04 42f3 81 08 4282 84"),
  ...ascii("webm"),
  ...hex("4287 81 04 4285 81 02"),
];

/** The same EBML header for a Matroska file (DocType `matroska`). */
export const MATROSKA_HEADER: readonly number[] = [
  ...hex("1a45dfa3 a3 4286 81 01 42f7 81 01 42f2 81 04 42f3 81 08 4282 88"),
  ...ascii("matroska"),
  ...hex("4287 81 04"),
];

/** A minimal recognised audio file of `length` bytes (a WAV header, zero-padded). */
export function wavFile(length = 44): Uint8Array {
  return audioBytes(WAV_HEADER, length);
}
