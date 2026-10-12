import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { importSpecifiers, readTypeScriptFiles } from "../helpers/source-files.js";

/** Layers that must stay free of providers, protocols, storage, and process globals. */
const CORE_LAYERS = ["src/domain", "src/ports", "src/app", "src/tools"];

const PROVIDER_OR_IO_PACKAGES = [
  /^openai(\/|$)/,
  /^@modelcontextprotocol\//,
  /^pino(\/|$)/,
  /^(node:)?(fs|fs\/promises|child_process|process|net|http|https|os)$/,
];

const OUTER_LAYERS = ["src/adapters/", "src/entrypoints/", "src/bootstrap/", "src/config/"];

function resolveRelative(fromPath: string, specifier: string): string {
  return specifier.startsWith(".") ? posix.join(posix.dirname(fromPath), specifier) : specifier;
}

function importsMatching(
  dirs: readonly string[],
  isViolation: (target: string) => boolean,
): string[] {
  return readTypeScriptFiles(...dirs).flatMap((file) =>
    importSpecifiers(file.text)
      .map((specifier) => resolveRelative(file.path, specifier))
      .filter(isViolation)
      .map((target) => `${file.path} imports ${target}`),
  );
}

describe("dependency direction", () => {
  it("parses every import form the rules depend on", () => {
    const source = [
      'import { a } from "openai";',
      'import type { B } from "../ports/logger.js";',
      'export { c } from "./c.js";',
      'import "node:fs";',
      'const d = await import("@modelcontextprotocol/server");',
    ].join("\n");

    expect(importSpecifiers(source)).toEqual(
      expect.arrayContaining([
        "openai",
        "../ports/logger.js",
        "./c.js",
        "node:fs",
        "@modelcontextprotocol/server",
      ]),
    );
  });

  it("keeps provider SDKs, MCP, logging libraries and I/O modules out of the core layers", () => {
    const violations = importsMatching(CORE_LAYERS, (target) =>
      PROVIDER_OR_IO_PACKAGES.some((pattern) => pattern.test(target)),
    );

    expect(violations).toEqual([]);
  });

  it("keeps the core layers from importing adapters, entrypoints, bootstrap, or config", () => {
    const violations = importsMatching(CORE_LAYERS, (target) =>
      OUTER_LAYERS.some((layer) => target.startsWith(layer)),
    );

    expect(violations).toEqual([]);
  });

  it("keeps the domain independent of every other layer", () => {
    const violations = importsMatching(
      ["src/domain"],
      (target) => target.startsWith("src/") && !target.startsWith("src/domain/"),
    );

    expect(violations).toEqual([]);
  });

  it("routes entrypoints through the composition root instead of wiring adapters or tools", () => {
    const violations = importsMatching(
      ["src/entrypoints"],
      (target) => target.startsWith("src/adapters/") || target.startsWith("src/tools/"),
    );

    expect(violations).toEqual([]);
  });

  it("lets only the persistence adapters import filesystem modules", () => {
    const fileSystem = /^(node:)?fs(\/promises)?$/;

    const importers = readTypeScriptFiles("src").flatMap((file) =>
      importSpecifiers(file.text).some((specifier) => fileSystem.test(specifier))
        ? [file.path]
        : [],
    );

    expect(importers.filter((path) => !path.startsWith("src/adapters/persistence/"))).toEqual([]);
    // The note store reaches the disk only through the `NoteFiles` seam in note-files.ts.
    expect(importers).toContain("src/adapters/persistence/note-files.ts");
    expect(importers).toContain("src/adapters/persistence/local-audio-files.ts");
  });

  it("lets only the OpenAI adapter import the openai package", () => {
    const importers = readTypeScriptFiles("src").flatMap((file) =>
      importSpecifiers(file.text).some((specifier) => /^openai(\/|$)/.test(specifier))
        ? [file.path]
        : [],
    );

    expect(importers.filter((path) => !path.startsWith("src/adapters/openai/"))).toEqual([]);
  });

  it("lets only the MCP adapter and the stdio composition import the MCP SDK", () => {
    const importers = readTypeScriptFiles("src").flatMap((file) =>
      importSpecifiers(file.text).some((specifier) => /^@modelcontextprotocol\//.test(specifier))
        ? [file.path]
        : [],
    );

    expect(
      importers.filter(
        (path) => !path.startsWith("src/adapters/mcp/") && path !== "src/bootstrap/serve-mcp.ts",
      ),
    ).toEqual([]);
    expect(importers).toContain("src/adapters/mcp/mcp-tool-descriptors.ts");
    expect(importers).toContain("src/bootstrap/serve-mcp.ts");
  });

  it("keeps the MCP adapter independent of the OpenAI projection and agent", () => {
    const violations = importsMatching(
      ["src/adapters/mcp"],
      (target) =>
        target.startsWith("src/app/agent/") ||
        target.startsWith("src/adapters/openai/") ||
        /^openai(\/|$)/.test(target),
    );

    expect(violations).toEqual([]);
  });

  it("keeps the MCP adapter on the injected executor: it builds none and imports no tool", () => {
    const files = readTypeScriptFiles("src/adapters/mcp");
    const buildsExecutor = files.filter((file) => /\bcreateToolExecutor\b/.test(file.text));

    const importsToolValues = importsMatching(
      ["src/adapters/mcp"],
      (target) => target.startsWith("src/tools/") && !target.endsWith("tool-definition.js"),
    );

    expect(files.length).toBeGreaterThan(0);
    expect(buildsExecutor.map((file) => file.path)).toEqual([]);
    expect(importsToolValues).toEqual([]);
  });

  it("keeps stdout for protocol traffic: no console, and the process streams only in the bin", () => {
    const files = readTypeScriptFiles("src");

    const consoleUsers = files
      .filter((file) => /\bconsole\s*\./.test(file.text))
      .map((file) => file.path);

    const streamUsers = files
      .filter((file) => /\bprocess\s*\.\s*(stdout|stdin)\b/.test(file.text))
      .map((file) => file.path);

    expect(consoleUsers).toEqual([]);
    expect(streamUsers).toEqual(["src/entrypoints/voice-agent.ts"]);
  });

  it("loads the MCP entrypoint lazily, and it reaches no OpenAI, agent, or speech module", () => {
    const sources = new Map(readTypeScriptFiles("src").map((file) => [file.path, file.text]));
    const bin = sources.get("src/entrypoints/voice-agent.ts") ?? "";

    expect(bin).toMatch(/await import\("\.\/mcp-stdio\.js"\)/);
    expect(bin).not.toMatch(/^import .* from "\.\/mcp-stdio\.js"/m);

    const reached = new Set<string>();
    const queue = ["src/entrypoints/mcp-stdio.ts"];

    for (let path = queue.pop(); path !== undefined; path = queue.pop()) {
      if (reached.has(path)) {
        continue;
      }

      reached.add(path);

      for (const specifier of importSpecifiers(sources.get(path) ?? "")) {
        const target = resolveRelative(path, specifier).replace(/\.js$/, ".ts");

        if (specifier.startsWith(".") && sources.has(target)) {
          queue.push(target);
        }
      }
    }

    const forbidden = [...reached].filter(
      (path) =>
        path.startsWith("src/adapters/openai/") ||
        path.startsWith("src/app/agent/") ||
        path.startsWith("src/app/audio/") ||
        path === "src/bootstrap/composition.ts" ||
        path === "src/entrypoints/cli.ts",
    );

    expect(reached.has("src/bootstrap/serve-mcp.ts")).toBe(true);
    expect(forbidden).toEqual([]);
  });

  it("keeps the OpenAI adapter and agent independent of the MCP adapter", () => {
    const violations = importsMatching(["src/adapters/openai", "src/app/agent"], (target) =>
      target.startsWith("src/adapters/mcp/"),
    );

    expect(violations).toEqual([]);
  });

  it("lets only the Realtime speech renderer use the platform WebSocket", () => {
    const users = readTypeScriptFiles("src")
      .filter((file) => /\bWebSocket\b/.test(file.text))
      .map((file) => file.path);

    expect(users).toEqual(["src/adapters/openai/realtime-text-to-speech.ts"]);
  });

  it("reads process.env only in src/config", () => {
    const readers = readTypeScriptFiles("src")
      .filter((file) => /\bprocess\s*\.\s*env\b|\bprocess\s*\[\s*["']env["']\s*\]/.test(file.text))
      .map((file) => file.path);

    expect(readers.filter((path) => !path.startsWith("src/config/"))).toEqual([]);
  });
});
