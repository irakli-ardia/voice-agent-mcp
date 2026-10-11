// Test-only server, started by the child-process tests (never part of the CLI). It is `runMcpStdio`
// with the production application, except that every note write stops inside its commit window
// until the parent test releases it over IPC. That lets a test cancel, close stdin, or fill the
// in-flight limit while a write is genuinely in progress.
//
// One file serves both test layers. Its first argument picks what it loads: "src" (the TypeScript
// sources, so the file must be started with the tsx loader) or "dist" (the compiled JavaScript,
// started by plain node). The public CLI has no such hook.
//
// To the parent: { type: "write-entered" | "write-aborted" | "write-committed", index } and
// { type: "closed", code }. From the parent: { type: "release", index }.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const tree = process.argv[2];

if (tree !== "src" && tree !== "dist") {
  throw new Error('The first argument must be "src" or "dist".');
}

const root = join(import.meta.dirname, "..", "..", tree);

// Source files import each other as `.js`; tsx resolves those to the `.ts` files.
const load = async (relative) => import(pathToFileURL(join(root, relative)).href);

const { createFileNoteStore } = await load("adapters/persistence/file-note-store.js");

const { systemClock } = await load("adapters/system/system-clock.js");

const { createToolExecutor } = await load("app/tools/tool-executor.js");

const { createToolRegistry } = await load("app/tools/tool-registry.js");

const { createApplication } = await load("bootstrap/create-application.js");

const { runMcpStdio } = await load("entrypoints/mcp-stdio.js");

const { defineCreateNoteTool } = await load("tools/create-note/create-note-tool.js");

const { defineReadNoteTool } = await load("tools/read-note/read-note-tool.js");

const gates = new Map();

const writes = [];

let entered = 0;

function gateFor(index) {
  if (!gates.has(index)) {
    gates.set(index, Promise.withResolvers());
  }

  return gates.get(index);
}

function tell(type, index) {
  process.send?.({ type, index });
}

process.on("message", (message) => {
  if (message?.type === "release" && Number.isInteger(message.index)) {
    gateFor(message.index).resolve();
  }
});

function gated(real) {
  return {
    read: async (noteId, signal) => real.read(noteId, signal),
    create: async (draft, signal) => {
      const index = entered;

      entered += 1;
      signal.addEventListener("abort", () => tell("write-aborted", index), { once: true });

      if (signal.aborted) {
        tell("write-aborted", index);
      }

      tell("write-entered", index);

      const write = (async () => {
        await gateFor(index).promise;

        // The commit window: an abort no longer stops the write, as with the real store's final link.
        const outcome = await real.create(draft, new AbortController().signal);

        tell("write-committed", index);

        return outcome;
      })();

      writes.push(write);

      return write;
    },
  };
}

function create(config) {
  const production = createApplication(config);

  const notes = gated(
    createFileNoteStore({ directory: join(config.dataDir, "notes"), logger: production.logger }),
  );

  const tools = createToolRegistry(
    production.tools.tools.map((tool) => {
      if (tool.name === "create_note") {
        return defineCreateNoteTool(notes);
      }

      return tool.name === "read_note" ? defineReadNoteTool(notes) : tool;
    }),
  );

  return {
    ...production,
    tools,
    executeTool: createToolExecutor({
      registry: tools,
      clock: systemClock,
      logger: production.logger,
      maxResultBytes: config.maxToolResultBytes,
    }),
  };
}

const code = await runMcpStdio(
  process.argv.slice(3),
  {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: (text) => {
      process.stderr.write(text);
    },
    signals: process,
  },
  create,
);

// A write the connection abandoned may still be committing: let it finish before leaving.
await Promise.allSettled(writes);

process.send?.({ type: "closed", index: -1, code });

process.exitCode = code;

process.disconnect();
