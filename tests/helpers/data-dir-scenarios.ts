import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CONFIG, EXIT_OK, EXIT_USAGE } from "../../src/entrypoints/exit-codes.js";
import {
  CLI_ENTRY,
  DIST_CLI_ENTRY,
  type McpChild,
  withinLimit,
  withMcpChild,
} from "./mcp-child.js";
import { callToolRequest, toolResultOf } from "./mcp-wire.js";

/** Appears in every rejected value, so a test can tell that nothing ever repeats one. */
const MARKER = "SENTINEL-DATA-DIR-8c3a";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Space {
  /** The working directory the host started the server in: empty, so any file is a side effect. */
  readonly cwd: string;
  /** An absolute path that does not exist yet. */
  readonly data: string;
  /** Everything under the space that exists, as relative paths. */
  everything(): Promise<readonly string[]>;
}

async function space(): Promise<Space> {
  const base = await mkdtemp(join(tmpdir(), "mcp-data-dir-"));
  const cwd = join(base, "host-cwd");

  directories.push(base);
  await mkdir(cwd);

  return {
    cwd,
    data: join(base, "data"),
    everything: async () =>
      (await readdir(base, { recursive: true })).map((name) => name.replaceAll("\\", "/")).sort(),
  };
}

function server(compiled: boolean, cwd: string, env: Readonly<Record<string, string>>) {
  return {
    entry: compiled ? DIST_CLI_ENTRY : CLI_ENTRY,
    compiled,
    args: ["mcp"],
    cwd,
    env,
  };
}

async function exitCodeOf(child: McpChild): Promise<number | null> {
  return (await withinLimit(child.exited, "the process to exit")).code;
}

/** Values that must be refused on every platform. */
const REJECTED_EVERYWHERE: readonly (readonly [string, string])[] = [
  ["empty", ""],
  ["blank", "   "],
  ["a tab", "\t"],
  ["a dot path", `.${MARKER}`],
  ["a relative name", `${MARKER}-notes`],
  ["a relative path", `./${MARKER}/notes`],
  ["a parent path", `../${MARKER}`],
  ["a home shorthand", `~/${MARKER}`],
];

/** Values that look absolute somewhere but name no fixed place here. */
const REJECTED_HERE: readonly (readonly [string, string])[] =
  process.platform === "win32"
    ? [
        ["the current drive's root", `\\${MARKER}`],
        ["a drive's current directory", `C:${MARKER}`],
        ["a forbidden character", `C:\\${MARKER}<notes>`],
        ["a POSIX path", `/${MARKER}/notes`],
      ]
    : [
        ["a Windows drive path", `C:\\${MARKER}`],
        ["a Windows drive path with a slash", `C:/${MARKER}`],
        ["a UNC path", `\\\\${MARKER}\\share`],
      ];

/**
 * The `DATA_DIR` policy over real processes, for the TypeScript sources (through tsx) and the built
 * distribution (plain node). Each case starts in an empty working directory chosen by the test, as
 * an MCP host would, and then looks at everything the process left behind.
 */
export function describeDataDirPolicy(label: string, compiled: boolean): void {
  describe(`DATA_DIR policy for mcp over real processes (${label})`, () => {
    vi.setConfig({ testTimeout: 60_000 });

    it("exits 78, names DATA_DIR, writes nothing and creates nothing when it is not set", async () => {
      const where = await space();
      const before = await where.everything();

      await withMcpChild(server(compiled, where.cwd, {}), async (child) => {
        expect(await exitCodeOf(child)).toBe(EXIT_CONFIG);
        expect(child.stderrText()).toContain("Invalid configuration:");
        expect(child.stderrText()).toContain("DATA_DIR: must be set to an absolute directory path");
        expect(child.stdoutLines).toEqual([]);
        expect(child.stdoutRemainder()).toBe("");
      });

      // Not even the old default `.data` in the host's working directory.
      expect(await where.everything()).toEqual(before);
    });

    it.each([...REJECTED_EVERYWHERE, ...REJECTED_HERE])(
      "exits 78 for %s, repeats nothing of the value, and leaves no file",
      async (_name, value) => {
        const where = await space();
        const before = await where.everything();

        await withMcpChild(server(compiled, where.cwd, { DATA_DIR: value }), async (child) => {
          expect(await exitCodeOf(child)).toBe(EXIT_CONFIG);
          expect(child.stderrText()).toContain("DATA_DIR:");
          expect(child.stderrText()).not.toContain(MARKER);
          expect(child.stdoutLines).toEqual([]);
        });

        expect(await where.everything()).toEqual(before);
      },
    );

    it("does not leak the working directory or the temp directory in its message", async () => {
      const where = await space();

      await withMcpChild(server(compiled, where.cwd, { DATA_DIR: "relative" }), async (child) => {
        await exitCodeOf(child);

        expect(child.stderrText()).not.toContain(where.cwd);
        expect(child.stderrText()).not.toContain(tmpdir());
      });
    });

    it("reports a bad argument first: exit 64, whatever DATA_DIR is", async () => {
      const where = await space();

      await withMcpChild(
        { ...server(compiled, where.cwd, {}), args: ["mcp", "extra"] },
        async (child) => {
          expect(await exitCodeOf(child)).toBe(EXIT_USAGE);
        },
      );
    });

    it("serves from an absolute DATA_DIR that does not exist yet, and writes only there", async () => {
      const where = await space();
      const before = await where.everything();

      await withMcpChild(server(compiled, where.cwd, { DATA_DIR: where.data }), async (child) => {
        // Nothing is created just by starting: the store prepares itself on the first write.
        await child.send(callToolRequest(1, "calculate", { operation: "add", a: 1, b: 2 }));
        await toolResultOf(child, 1);
        expect(await where.everything()).toEqual(before);

        await child.send(
          callToolRequest(2, "create_note", {
            text: "kept where the user said",
            idempotencyKey: "data-dir-policy-key-0001",
          }),
        );
        expect((await toolResultOf(child, 2)).isError).toBeUndefined();
        child.endStdin();
        expect(await exitCodeOf(child)).toBe(EXIT_OK);
        expect(child.strayStdout()).toEqual([]);
      });

      const notes = await readdir(join(where.data, "notes"));

      expect(notes.filter((name) => name.endsWith(".json"))).toHaveLength(1);
      // The host's working directory is exactly as the host left it.
      expect(await readdir(where.cwd)).toEqual([]);
    });

    it("accepts a DATA_DIR that already exists", async () => {
      const where = await space();

      await mkdir(where.data);
      await withMcpChild(server(compiled, where.cwd, { DATA_DIR: where.data }), async (child) => {
        child.endStdin();
        expect(await exitCodeOf(child)).toBe(EXIT_OK);
      });
    });

    describe("the other commands keep their behaviour", () => {
      const cli = (
        cwd: string,
        args: readonly string[],
        env: Readonly<Record<string, string>>,
      ) => ({
        entry: compiled ? DIST_CLI_ENTRY : CLI_ENTRY,
        compiled,
        args,
        cwd,
        env,
      });

      it.each([["--help"], ["-h"]])("%s works with no DATA_DIR", async (flag) => {
        const where = await space();
        const before = await where.everything();

        await withMcpChild(cli(where.cwd, [flag], {}), async (child) => {
          expect(await exitCodeOf(child)).toBe(EXIT_OK);
          expect(child.stdoutLines.join("\n")).toContain("Usage: voice-agent");
        });

        expect(await where.everything()).toEqual(before);
      });

      it.each([
        ["unset", {}],
        ["relative", { DATA_DIR: "notes" }],
        ["absolute", { DATA_DIR: "" }],
      ] as const)("tools works with DATA_DIR %s where it is accepted", async (kind, env) => {
        const where = await space();
        const value = kind === "absolute" ? { DATA_DIR: where.data } : env;

        await withMcpChild(cli(where.cwd, ["tools"], value), async (child) => {
          expect(await exitCodeOf(child)).toBe(EXIT_OK);
          expect(child.stdoutLines.join("\n")).toContain("create_note");
          expect(child.stderrText()).not.toContain("DATA_DIR");
        });
      });

      it("ask is not stopped by the policy: with no DATA_DIR it fails only for its own reason", async () => {
        const where = await space();

        await withMcpChild(cli(where.cwd, ["ask", "--text", "hello"], {}), async (child) => {
          await exitCodeOf(child);

          expect(child.stderrText()).not.toContain("DATA_DIR");
          expect(child.stderrText()).toContain("OPENAI_API_KEY");
        });
      });

      it("ask still takes a relative DATA_DIR as before", async () => {
        const where = await space();

        await withMcpChild(
          cli(where.cwd, ["ask", "--text", "hello"], { DATA_DIR: "notes" }),
          async (child) => {
            await exitCodeOf(child);

            expect(child.stderrText()).not.toContain("DATA_DIR");
          },
        );
      });
    });
  });
}
