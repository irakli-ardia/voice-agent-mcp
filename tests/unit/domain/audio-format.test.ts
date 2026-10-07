import { describe, expect, it } from "vitest";
import { detectAudioFormat, MAX_AUDIO_BYTES } from "../../../src/domain/audio-format.js";
import {
  ascii,
  audioBytes,
  ftypBox,
  id3Tag,
  MATROSKA_HEADER,
  MP3_FRAME,
  WAV_HEADER,
  WEBM_HEADER,
} from "../../helpers/audio-bytes.js";

describe("detectAudioFormat: accepted formats", () => {
  it("recognises WAV by RIFF and WAVE", () => {
    expect(detectAudioFormat(audioBytes(WAV_HEADER, 44))).toBe("wav");
  });

  it("accepts a header of exactly 12 bytes", () => {
    expect(detectAudioFormat(audioBytes(WAV_HEADER))).toBe("wav");
  });

  it.each([
    ["MPEG-1 Layer III", [0xff, 0xfb, 0x90, 0x64]],
    ["MPEG-1 Layer III without CRC protection bit set", [0xff, 0xfa, 0x90, 0x64]],
    ["MPEG-2 Layer III", [0xff, 0xf3, 0x90, 0x64]],
    ["MPEG-2.5 Layer III", [0xff, 0xe3, 0x90, 0x64]],
    ["a free-format bitrate", [0xff, 0xfb, 0x00, 0x64]],
  ])("recognises an MP3 frame: %s", (_name, frame) => {
    expect(detectAudioFormat(audioBytes(frame, 12))).toBe("mp3");
  });

  it.each([2, 3, 4])("recognises an MP3 frame after an ID3v2.%i tag", (version) => {
    expect(detectAudioFormat(audioBytes([...id3Tag(20, version), ...MP3_FRAME], 64))).toBe("mp3");
  });

  it("skips the 10-byte footer an ID3v2.4 tag declares", () => {
    const withFooter = [...id3Tag(4, 4, 0x10), ...new Array<number>(10).fill(0), ...MP3_FRAME];

    expect(detectAudioFormat(audioBytes(withFooter, 64))).toBe("mp3");
  });

  it("decodes the synchsafe tag size across all four bytes", () => {
    // 200 = 0b1_1001000: the second-lowest size byte carries a bit.
    expect(detectAudioFormat(audioBytes([...id3Tag(200), ...MP3_FRAME]))).toBe("mp3");
  });

  it.each(["M4A ", "M4B ", "mp41", "mp42", "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "dash"])(
    "recognises MP4/M4A with the major brand %j",
    (brand) => {
      expect(detectAudioFormat(audioBytes(ftypBox(brand), 32))).toBe("mp4");
    },
  );

  it("accepts the smallest complete ftyp box (16 bytes)", () => {
    expect(detectAudioFormat(audioBytes(ftypBox("M4A ", 16), 16))).toBe("mp4");
  });

  it("recognises WebM by its EBML DocType", () => {
    expect(detectAudioFormat(audioBytes(WEBM_HEADER, 64))).toBe("webm");
  });

  it("reads a view that starts inside a larger buffer", () => {
    const buffer = new Uint8Array(64);

    buffer.set(ftypBox("isom", 24), 8);

    expect(detectAudioFormat(buffer.subarray(8, 40))).toBe("mp4");
  });
});

describe("detectAudioFormat: rejected content", () => {
  it.each([
    ["empty", []],
    ["11 bytes of a WAV header", WAV_HEADER.slice(0, 11)],
    ["a lone 4-byte MP3 frame header", MP3_FRAME],
    ["an MP3 frame header padded to 11 bytes", [...MP3_FRAME, 0, 0, 0, 0, 0, 0, 0]],
  ])("rejects input shorter than 12 bytes: %s", (_name, bytes) => {
    expect(detectAudioFormat(new Uint8Array(bytes))).toBeNull();
  });

  // Our contract is narrower than the provider's: these are not claims about OpenAI support.
  it.each([
    ["FLAC", [...ascii("fLaC"), 0, 0, 0, 34]],
    ["Ogg", [...ascii("OggS"), 0, 2]],
    ["RIFF AVI", [...ascii("RIFF"), 0, 0, 0, 0, ...ascii("AVI ")]],
    ["RF64", [...ascii("RF64"), 0, 0, 0, 0, ...ascii("WAVE")]],
    ["AIFF", [...ascii("FORM"), 0, 0, 0, 0, ...ascii("AIFF")]],
  ])("rejects a format outside our contract: %s", (_name, header) => {
    expect(detectAudioFormat(audioBytes(header, 64))).toBeNull();
  });

  it.each([
    ["Layer II", [0xff, 0xfd, 0x90, 0x64]],
    ["Layer I", [0xff, 0xff, 0x90, 0x64]],
    ["AAC ADTS (layer bits 00)", [0xff, 0xf1, 0x50, 0x80]],
    ["the reserved MPEG version", [0xff, 0xeb, 0x90, 0x64]],
    ["the invalid bitrate index", [0xff, 0xfb, 0xf0, 0x64]],
    ["the reserved sample rate", [0xff, 0xfb, 0x9c, 0x64]],
    ["no frame sync", [0xfe, 0xfb, 0x90, 0x64]],
    ["an incomplete frame sync", [0xff, 0x1b, 0x90, 0x64]],
  ])("rejects an MPEG near-miss: %s", (_name, frame) => {
    expect(detectAudioFormat(audioBytes(frame, 12))).toBeNull();
  });

  it.each([
    ["ID3v2.5", [...id3Tag(4, 5), ...MP3_FRAME]],
    ["ID3v2.1", [...id3Tag(4, 1), ...MP3_FRAME]],
    ["revision 0xFF", [...ascii("ID3"), 3, 0xff, 0, 0, 0, 0, 0, ...MP3_FRAME]],
    ["a size byte with its high bit set", [...ascii("ID3"), 3, 0, 0, 0, 0, 0, 0x80, ...MP3_FRAME]],
    ["FLAC after the tag", [...id3Tag(4), ...ascii("fLaC"), 0, 0]],
    ["nothing after the tag", id3Tag(40)],
  ])("rejects an ID3 tag that is not followed by valid MP3 audio: %s", (_name, bytes) => {
    expect(detectAudioFormat(audioBytes(bytes, 12))).toBeNull();
  });

  it("rejects a tag size pointing past the end of the input", () => {
    expect(
      detectAudioFormat(audioBytes([...ascii("ID3"), 3, 0, 0, 0, 0, 0x7f, 0x7f], 64)),
    ).toBeNull();
  });

  it.each(["qt  ", "3gp4", "heic", "avif", "M4V ", "crx "])(
    "rejects the ISO media brand %j (video, images, other containers)",
    (brand) => {
      expect(detectAudioFormat(audioBytes(ftypBox(brand), 32))).toBeNull();
    },
  );

  it.each([
    ["a box smaller than 16 bytes", ftypBox("M4A ", 12), 32],
    ["a box larger than the input", ftypBox("M4A ", 33), 32],
  ])("rejects an ftyp box with %s", (_name, box, length) => {
    expect(detectAudioFormat(audioBytes(box, length))).toBeNull();
  });

  it("rejects ftyp at the wrong offset", () => {
    expect(detectAudioFormat(audioBytes([...ascii("ftypM4A "), 0, 0, 0, 0], 32))).toBeNull();
  });

  it("rejects Matroska, which shares WebM's EBML magic", () => {
    expect(detectAudioFormat(audioBytes(MATROSKA_HEADER, 64))).toBeNull();
  });

  it("rejects a WebM DocType that starts beyond the first 64 bytes", () => {
    const docType = WEBM_HEADER.slice(21, 28);
    const late = audioBytes([0x1a, 0x45, 0xdf, 0xa3, ...new Array<number>(54).fill(0), ...docType]);

    expect(late.indexOf(0x42, 4)).toBe(58);
    expect(detectAudioFormat(late)).toBeNull();
  });

  it("accepts a WebM DocType that ends exactly at byte 64", () => {
    const docType = WEBM_HEADER.slice(21, 28);
    const edge = audioBytes([0x1a, 0x45, 0xdf, 0xa3, ...new Array<number>(53).fill(0), ...docType]);

    expect(edge.byteLength).toBe(64);
    expect(detectAudioFormat(edge)).toBe("webm");
  });

  it.each([
    ["plain text", ascii("Hello, world! This is not audio.")],
    ["a .env file", ascii("OPENAI_API_KEY=sk-not-audio\n")],
    ["JSON", ascii('{"type":"audio","data":"..."}')],
    ["PDF", ascii("%PDF-1.7\n%âã")],
    ["ZIP", [0x50, 0x4b, 0x03, 0x04, ...new Array<number>(12).fill(0)]],
    ["PNG", [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]],
    ["zeros", new Array<number>(64).fill(0)],
  ])("rejects non-audio content: %s", (_name, bytes) => {
    expect(detectAudioFormat(new Uint8Array(bytes))).toBeNull();
  });
});

describe("MAX_AUDIO_BYTES", () => {
  it("is 8 MiB, a third of the provider's 25 MB upload limit", () => {
    expect(MAX_AUDIO_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_AUDIO_BYTES).toBeLessThan(25_000_000 / 2);
  });
});
