// Test-only process for the built-distribution tests of `ask` shutdown (never part of the product).
// It is `voice-agent ask` with the model replaced by a script, and nothing else: the real shutdown glue
// (runUntilStopped), the real CLI (runCli), the real agent runner, the real executor, the real
// create_note tool and the real file note store. Only the store's publication step (the hard link to
// the note's name) is held, so a signal can arrive while a write is past its commit point.
//
//   node ask-note-child.mjs <release|never|none>
//     release: hold the publication, then let it finish 700 ms later
//     never:   hold the publication for good (a write blocked in the filesystem)
//     none:    no hold (control)
// Prints HELD on stdout when the publication is held. DATA_DIR and OPENAI_API_KEY come from the
// environment (the key is a dummy: the model never calls the network).

import { join } from "node:path";
import { pathToFileURL } from "node:url";

// dist/ exists only after a build, so it is loaded at run time (static analysis cannot resolve it).
const load = async (relative) =>
  import(pathToFileURL(join(import.meta.dirname, "..", "..", "dist", relative)).href);

const { createPinoLogger } = await load("adapters/logging/pino-logger.js");

const { createFileNoteStore } = await load("adapters/persistence/file-note-store.js");

const { nodeNoteFiles } = await load("adapters/persistence/note-files.js");

const { systemClock } = await load("adapters/system/system-clock.js");

const { systemIdGenerator } = await load("adapters/system/system-id-generator.js");

const { createAgentRunner } = await load("app/agent/agent-runner.js");

const { createHandlerLedger } = await load("app/tools/handler-ledger.js");

const { createToolExecutor } = await load("app/tools/tool-executor.js");

const { createToolRegistry } = await load("app/tools/tool-registry.js");

const { runCli } = await load("entrypoints/cli.js");

const { runUntilStopped } = await load("entrypoints/interrupt.js");

const { defineCreateNoteTool } = await load("tools/create-note/create-note-tool.js");

const hold = process.argv[2];

const files = {
  ...nodeNoteFiles,
  link: async (existing, target) => {
    if (target.endsWith(".json") && hold !== "none") {
      process.stdout.write("HELD\n");

      if (hold === "release") {
        await new Promise((resolve) => setTimeout(resolve, 700));
      } else {
        // A request stuck in the filesystem keeps the event loop alive; a timer stands in for it.
        setInterval(() => undefined, 1_000);
        await new Promise(() => undefined);
      }
    }

    await nodeNoteFiles.link(existing, target);
  },
};

const model = {
  respond: async (request) => {
    const answered = request.transcript.some((item) => item.kind === "tool_result");

    return {
      ok: true,
      value: answered
        ? { text: "saved", toolCalls: [], continuation: "after" }
        : {
            text: null,
            toolCalls: [
              {
                callId: "call-1",
                name: "create_note",
                arguments: { text: "written during ask", idempotencyKey: "ask-shutdown-key-0001" },
              },
            ],
            continuation: "before",
          },
    };
  },
};

const composition = {
  createApplication: (config) => {
    const logger = createPinoLogger({ level: "silent" });

    const notes = createFileNoteStore({
      directory: join(config.dataDir, "notes"),
      slotDirectory: join(config.dataDir, "note-slots"),
      maxNotes: config.maxNotes,
      files,
      logger,
    });

    const handlerLedger = createHandlerLedger({ maxAbandoned: 3 });
    const tools = createToolRegistry([defineCreateNoteTool(notes)]);

    return {
      config,
      logger,
      tools,
      handlerLedger,
      flushLogs: async () => undefined,
      executeTool: createToolExecutor({
        registry: tools,
        clock: systemClock,
        logger,
        maxResultBytes: config.maxToolResultBytes,
        handlerLedger,
      }),
    };
  },
  createAgent: (application) =>
    createAgentRunner({
      model,
      registry: application.tools,
      executeTool: application.executeTool,
      ids: systemIdGenerator,
      clock: systemClock,
      logger: application.logger,
      limits: application.config.agent,
    }),
  createTranscriber: () => {
    throw new Error("not used");
  },
  createSpeechOutput: () => {
    throw new Error("not used");
  },
};

process.exitCode = await runUntilStopped(
  async (signal) =>
    runCli(
      ["ask", "--text", "save a note"],
      {
        stdout: (text) => {
          process.stdout.write(text);
        },
        stderr: (text) => {
          process.stderr.write(text);
        },
        signal,
      },
      composition,
    ),
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
