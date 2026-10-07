import { describe, expect, it } from "vitest";
import {
  PCM16_SAMPLE_RATE,
  pcm16Wav,
  WAV_HEADER_BYTES,
} from "../../../../src/adapters/openai/pcm16-wav.js";

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

describe("pcm16Wav", () => {
  it("writes the canonical 44-byte header for one 16-bit sample, byte for byte", () => {
    const wav = pcm16Wav([new Uint8Array([0x34, 0x12])], 2);

    expect(hex(wav)).toBe(
      [
        "52494646", // "RIFF"
        "26000000", // 36 + 2
        "57415645", // "WAVE"
        "666d7420", // "fmt "
        "10000000", // fmt chunk size 16
        "0100", // PCM
        "0100", // mono
        "c05d0000", // 24 000 Hz
        "80bb0000", // 48 000 bytes per second
        "0200", // block align
        "1000", // 16 bits per sample
        "64617461", // "data"
        "02000000", // data size 2
        "3412", // the sample, unchanged
      ].join(""),
    );
    expect(WAV_HEADER_BYTES).toBe(44);
    expect(PCM16_SAMPLE_RATE).toBe(24_000);
  });

  it("writes little-endian sizes for the largest rendering (9 600 000 PCM bytes)", () => {
    const pcm = new Uint8Array(9_600_000);
    const wav = pcm16Wav([pcm], pcm.byteLength);
    const view = new DataView(wav.buffer);

    expect(wav.byteLength).toBe(9_600_044);
    expect(view.getUint32(4, true)).toBe(9_600_036);
    expect(view.getUint32(40, true)).toBe(9_600_000);
  });

  it("joins chunks in order, including odd-length chunks with an even total", () => {
    const wav = pcm16Wav([new Uint8Array([1]), new Uint8Array([2, 3, 4]), new Uint8Array([])], 4);

    expect([...wav.subarray(WAV_HEADER_BYTES)]).toEqual([1, 2, 3, 4]);
  });

  it.each([
    ["no data", [], 0],
    ["an odd number of bytes", [new Uint8Array(3)], 3],
    ["a length that is not the chunks' total", [new Uint8Array(4)], 6],
  ])("refuses %s", (_name, chunks, byteLength) => {
    expect(() => pcm16Wav(chunks, byteLength)).toThrow(RangeError);
  });
});
