#!/usr/bin/env node
import { runCli } from "./cli.js";
import { onFirstInterrupt } from "./interrupt.js";

const argv = process.argv.slice(2);

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
    // The one place the process may be ended for the server: see `McpStdioIo.forceExit`.
    forceExit: (code: number): void => {
      process.exit(code);
    },
  });
} else {
  const controller = new AbortController();

  const removeInterruptHandler = onFirstInterrupt(process, controller);

  process.exitCode = await runCli(argv, {
    stdout: (text: string): void => {
      process.stdout.write(text);
    },
    stderr: (text: string): void => {
      process.stderr.write(text);
    },
    signal: controller.signal,
  });

  removeInterruptHandler();
}
