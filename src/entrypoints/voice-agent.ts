#!/usr/bin/env node
import { runCli } from "./cli.js";

process.exitCode = runCli(process.argv.slice(2), {
  stdout: (text: string): void => {
    process.stdout.write(text);
  },
  stderr: (text: string): void => {
    process.stderr.write(text);
  },
});
