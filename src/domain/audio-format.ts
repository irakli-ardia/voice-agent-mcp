/**
 * The audio formats this application accepts as input. Our contract is intentionally narrower than
 * every format the provider documents: it covers the formats the speech-to-text guide lists (mp3,
 * mp4, mpeg, mpga, m4a, wav, webm), recognised from content, never from a file name.
 */
export type AudioFormat = "wav" | "mp3" | "mp4" | "webm";

/**
 * Largest audio input, in bytes (8 MiB): about 43 s of 48 kHz 16-bit stereo WAV, minutes of MP3.
 * Bounds memory and upload size for short spoken requests. It does not bound duration: a file this
 * size at a very low bitrate can hold hours of audio.
 */
export const MAX_AUDIO_BYTES = 8_388_608;

/** The shortest input any accepted header check can read. */
const MIN_HEADER_BYTES = 12;

/** ISO base media major brands of MP4 and M4A audio; QuickTime, 3GP, and HEIC are not among them. */
const MP4_BRANDS: ReadonlySet<string> = new Set([
  "M4A ",
  "M4B ",
  "mp41",
  "mp42",
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "dash",
]);

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];

/** The EBML DocType element (`42 82`), a one-byte size of 4 (`84`), and `webm`. */
const WEBM_DOCTYPE = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];

/** How far into an EBML header the DocType is looked for. */
const WEBM_DOCTYPE_WINDOW = 64;

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function startsWithAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function isWav(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
}

/**
 * An MPEG audio Layer III frame header at `offset`: frame sync, a defined MPEG version, layer III,
 * a usable bitrate index, and a defined sample rate. Layer I and II frames are not accepted.
 */
function isLayerThreeFrame(bytes: Uint8Array, offset: number): boolean {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  const third = bytes[offset + 2];

  if (first !== 0xff || second === undefined || third === undefined) {
    return false;
  }

  const syncAndLayerThree = (second & 0xe6) === 0xe2;
  const versionDefined = ((second >> 3) & 0b11) !== 0b01;
  const bitrateUsable = third >> 4 !== 0b1111;
  const sampleRateDefined = ((third >> 2) & 0b11) !== 0b11;

  return syncAndLayerThree && versionDefined && bitrateUsable && sampleRateDefined;
}

/** Where the audio after an ID3v2 tag starts, or `null` when the tag header is not valid ID3v2. */
function afterId3Tag(bytes: Uint8Array): number | null {
  const majorVersion = bytes[3];
  const sizeBytes = bytes.subarray(6, 10);

  if (
    ascii(bytes, 0, 3) !== "ID3" ||
    majorVersion === undefined ||
    majorVersion < 2 ||
    majorVersion > 4 ||
    bytes[4] === 0xff ||
    sizeBytes.some((byte) => byte >= 0x80)
  ) {
    return null;
  }

  // A synchsafe integer: 7 bits per byte. Flag 0x10 (v2.4) adds a 10-byte footer.
  const size = sizeBytes.reduce((total, byte) => total * 128 + byte, 0);
  const footer = ((bytes[5] ?? 0) & 0x10) === 0 ? 0 : 10;

  return 10 + size + footer;
}

/** An MP3 is an MPEG audio Layer III frame, optionally after one ID3v2 tag. */
function isMp3(bytes: Uint8Array): boolean {
  const audioStart = ascii(bytes, 0, 3) === "ID3" ? afterId3Tag(bytes) : 0;

  return audioStart !== null && isLayerThreeFrame(bytes, audioStart);
}

/** An ISO base media file whose first box is a complete `ftyp` with an MP4 or M4A major brand. */
function isMp4(bytes: Uint8Array): boolean {
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);

  return (
    ascii(bytes, 4, 4) === "ftyp" &&
    boxSize >= 16 &&
    boxSize <= bytes.byteLength &&
    MP4_BRANDS.has(ascii(bytes, 8, 4))
  );
}

/** An EBML file declaring the `webm` DocType; Matroska and other EBML documents are not accepted. */
function isWebm(bytes: Uint8Array): boolean {
  if (!startsWithAt(bytes, 0, EBML_MAGIC)) {
    return false;
  }

  const last = Math.min(bytes.byteLength, WEBM_DOCTYPE_WINDOW) - WEBM_DOCTYPE.length;

  for (let offset = EBML_MAGIC.length; offset <= last; offset += 1) {
    if (startsWithAt(bytes, offset, WEBM_DOCTYPE)) {
      return true;
    }
  }

  return false;
}

/**
 * The accepted format the bytes begin with, or `null`. A recognised header is not a decode check:
 * a corrupt file with a valid header is accepted here and rejected by the provider.
 */
export function detectAudioFormat(bytes: Uint8Array): AudioFormat | null {
  if (bytes.byteLength < MIN_HEADER_BYTES) {
    return null;
  }

  if (isWav(bytes)) {
    return "wav";
  }

  if (isMp4(bytes)) {
    return "mp4";
  }

  if (isWebm(bytes)) {
    return "webm";
  }

  return isMp3(bytes) ? "mp3" : null;
}
