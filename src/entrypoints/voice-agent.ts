#!/usr/bin/env node
import { runCli } from "./cli.js";
import { onFirstInterrupt } from "./interrupt.js";

const controller = new AbortController();

const removeInterruptHandler = onFirstInterrupt(process, controller);

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
  signal: controller.signal,
});

removeInterruptHandler();
