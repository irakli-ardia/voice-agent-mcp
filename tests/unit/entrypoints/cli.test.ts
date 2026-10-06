import { describe, expect, it } from "vitest";
import {
  type CliIo,
  EXIT_CONFIG,
  EXIT_OK,
  EXIT_USAGE,
  runCli,
} from "../../../src/entrypoints/cli.js";

interface CapturedIo {
  readonly io: CliIo;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function captureIo(env: Readonly<Record<string, string | undefined>>): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];

  return {
    io: {
      env,
      stdout: (text: string): void => {
        out.push(text);
      },
      stderr: (text: string): void => {
        err.push(text);
      },
    },
    stdout: (): string => out.join(""),
    stderr: (): string => err.join(""),
  };
}

const QUIET = { LOG_LEVEL: "silent" };

describe("runCli", () => {
  it("prints usage to stdout and exits 0 for --help", () => {
    const captured = captureIo(QUIET);

    expect(runCli(["--help"], captured.io)).toBe(EXIT_OK);
    expect(captured.stdout()).toContain("Usage: voice-agent");
    expect(captured.stderr()).toBe("");
  });

  it("exits 64 with usage on stderr for an unknown command", () => {
    const captured = captureIo(QUIET);

    expect(runCli(["bogus"], captured.io)).toBe(EXIT_USAGE);
    expect(captured.stdout()).toBe("");
    expect(captured.stderr()).toContain("Usage: voice-agent");
  });

  it("exits 64 for an unknown option", () => {
    const captured = captureIo(QUIET);

    expect(runCli(["--nope"], captured.io)).toBe(EXIT_USAGE);
    expect(captured.stderr()).toContain("Usage: voice-agent");
  });

  it("exits 78 and names the variable for invalid configuration", () => {
    const captured = captureIo({ LOG_LEVEL: "loud" });

    expect(runCli(["--help"], captured.io)).toBe(EXIT_CONFIG);
    expect(captured.stderr()).toContain("LOG_LEVEL");
    expect(captured.stdout()).toBe("");
  });
});
