// Test-only process for the built-distribution tests of `ask` shutdown (never part of the product).
// It wires the bin's shutdown glue exactly as `voice-agent.js` does for `ask` (runUntilStopped with
// process.exit as the one forced exit), around a command that the scenario controls, so real
// signals reach real code in a real process. `ask` itself needs a key and a network.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// dist/ exists only after a build, so it is loaded at run time (static analysis cannot resolve it).
const { runUntilStopped } = await import(
  pathToFileURL(join(import.meta.dirname, "..", "..", "dist", "entrypoints", "interrupt.js")).href
);

const scenario = process.argv[2];

const STOPPED = 130;

/** Keeps the process alive the way a tool blocked in the filesystem would. */
const hold = () => {
  setInterval(() => undefined, 1_000);
};

const commands = {
  // A cancelled turn: stops when told to.
  cooperative: async (signal) => {
    // Pending work that the abort ends, as a cancelled request does.
    const pending = setInterval(() => undefined, 1_000);

    return new Promise((resolve) => {
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(pending);
          resolve(STOPPED);
        },
        { once: true },
      );
    });
  },
  // A turn stuck in work it cannot abandon: ignores the signal and never ends.
  stuck: async () => {
    hold();

    return new Promise(() => undefined);
  },
  // A command that finished but left something running behind it.
  held: async () => {
    hold();

    return 0;
  },
};

const run = commands[scenario];

if (run === undefined) {
  process.stderr.write("unknown scenario\n");
  process.exit(2);
}

process.exitCode = await runUntilStopped(
  async (signal) => {
    process.stdout.write("READY\n");

    return run(signal);
  },
  {
    signals: process,
    forceExit: (code) => {
      process.exit(code);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
  },
);
