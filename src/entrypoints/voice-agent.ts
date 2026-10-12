#!/usr/bin/env node
import { runCli } from "./cli.js";
import { runUntilStopped } from "./interrupt.js";

const argv = process.argv.slice(2);

/** The one place the process may be ended for a command: see `StopIo.forceExit`. */
const forceExit = (code: number): void => {
  process.exit(code);
};

if (argv[0] === "mcp") {
  // Loaded only for this command: ask and tools never load the MCP SDK.
  const { runMcpStdio } = await import("./mcp-stdio.js");

  process.exitCode = await runMcpStdio(argv.slice(1), {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
    signals: process,
    forceExit,
  });
} else {
  process.exitCode = await runUntilStopped(
    async (signal) =>
      runCli(argv, {
        stdout: (text: string): void => {
          process.stdout.write(text);
        },
        stderr: (text: string): void => {
          process.stderr.write(text);
        },
        signal,
      }),
    {
      signals: process,
      forceExit,
      stderr: (text: string): void => {
        process.stderr.write(text);
      },
    },
  );
}
