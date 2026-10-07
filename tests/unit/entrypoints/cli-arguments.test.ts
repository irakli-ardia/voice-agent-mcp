import { describe, expect, it } from "vitest";
import { parseCommand, USAGE, USAGE_REASONS } from "../../../src/entrypoints/cli-arguments.js";

const MAX_CHARS = 20;

function parse(argv: readonly string[]): ReturnType<typeof parseCommand> {
  return parseCommand(argv, MAX_CHARS);
}

describe("parseCommand: ask inputs", () => {
  it.each([
    [["ask", "--text", "What time is it?"], { kind: "text", text: "What time is it?" }, null],
    [["ask", "--audio", "question.wav"], { kind: "audio", path: "question.wav" }, null],
    [
      ["ask", "--text", "Hi", "--speech-out", "answer.wav"],
      { kind: "text", text: "Hi" },
      "answer.wav",
    ],
    [
      ["ask", "--speech-out", "C:\\out\\Answer.WAV", "--audio", "q.m4a"],
      { kind: "audio", path: "q.m4a" },
      "C:\\out\\Answer.WAV",
    ],
    [
      ["ask", "--audio=-starts-with-dash.wav"],
      { kind: "audio", path: "-starts-with-dash.wav" },
      null,
    ],
  ])("parses %j", (argv, input, speechOut) => {
    expect(parse(argv)).toEqual({ kind: "ask", input, speechOut });
  });

  it("accepts text of exactly MAX_INPUT_TEXT_CHARS", () => {
    expect(parse(["ask", "--text", "x".repeat(MAX_CHARS)])).toMatchObject({ kind: "ask" });
  });
});

describe("parseCommand: usage errors, before any work", () => {
  it.each([
    ["neither input", ["ask"], "missing_input"],
    ["only --speech-out", ["ask", "--speech-out", "a.wav"], "missing_input"],
    ["both inputs", ["ask", "--text", "Hi", "--audio", "q.wav"], "conflicting_input"],
    ["blank text", ["ask", "--text", " \n "], "blank_text"],
    ["text over the limit", ["ask", "--text", "x".repeat(MAX_CHARS + 1)], "text_too_long"],
    ["a blank audio path", ["ask", "--audio", " "], "blank_path"],
    ["an audio path of -", ["ask", "--audio=-"], "blank_path"],
    ["an empty speech path", ["ask", "--text", "Hi", "--speech-out", ""], "blank_path"],
    ["a speech path of -", ["ask", "--text", "Hi", "--speech-out=-"], "blank_path"],
    ["an mp3 speech file", ["ask", "--text", "Hi", "--speech-out", "a.mp3"], "speech_out_not_wav"],
    [
      "a speech file without extension",
      ["ask", "--text", "Hi", "--speech-out", "a"],
      "speech_out_not_wav",
    ],
    [
      "a speech directory path",
      ["ask", "--text", "Hi", "--speech-out", "out.wav/"],
      "speech_out_not_wav",
    ],
    [
      "a .wav directory with another name",
      ["ask", "--text", "Hi", "--speech-out", "x.wav\\a.txt"],
      "speech_out_not_wav",
    ],
    [
      "an alternate data stream",
      ["ask", "--text", "Hi", "--speech-out", "notes.txt:a.wav"],
      "speech_out_bad_name",
    ],
    ["a repeated --text", ["ask", "--text", "a", "--text", "b"], "repeated_option"],
    ["a repeated --audio", ["ask", "--audio", "a.wav", "--audio", "b.wav"], "repeated_option"],
    [
      "a repeated --speech-out",
      ["ask", "--text", "a", "--speech-out", "a.wav", "--speech-out", "b.wav"],
      "repeated_option",
    ],
    ["--audio with tools", ["tools", "--audio", "a.wav"], "option_not_allowed"],
    ["--speech-out with tools", ["tools", "--speech-out", "a.wav"], "option_not_allowed"],
    ["a missing --audio value", ["ask", "--audio"], "invalid_arguments"],
    ["a missing --speech-out value", ["ask", "--text", "Hi", "--speech-out"], "invalid_arguments"],
    [
      "an option taken as a value",
      ["ask", "--audio", "--speech-out", "a.wav"],
      "invalid_arguments",
    ],
    ["an unknown option", ["ask", "--voice", "marin"], "invalid_arguments"],
    ["a positional input", ["ask", "question.wav"], "unknown_command"],
  ])("rejects %s", (_name, argv, problem) => {
    expect(parse(argv)).toMatchObject({ kind: "usage", problem });
  });

  it("gives every user-correctable problem a reason that names no user input", () => {
    for (const reason of Object.values(USAGE_REASONS)) {
      expect(reason === undefined || /^[\w\s"'<>().,:-]+$/.test(reason)).toBe(true);
    }
  });
});

describe("usage text", () => {
  it("documents both inputs, the WAV output, and that the voice is AI-generated", () => {
    expect(USAGE).toContain("ask --text <text>");
    expect(USAGE).toContain("ask --audio <file>");
    expect(USAGE).toContain("--speech-out <file.wav>");
    expect(USAGE).toContain("The voice is AI-generated (OpenAI text-to-speech), not a");
    expect(USAGE).toContain("human voice");
    expect(USAGE).toContain("never");
  });

  it("is chosen for --help over anything else", () => {
    expect(parse(["ask", "--audio", "q.wav", "--help"])).toEqual({ kind: "help" });
  });
});
