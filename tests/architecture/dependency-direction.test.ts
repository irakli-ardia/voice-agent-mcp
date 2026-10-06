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

  it("reads process.env only in src/config", () => {
    const readers = readTypeScriptFiles("src")
      .filter((file) => /\bprocess\s*\.\s*env\b|\bprocess\s*\[\s*["']env["']\s*\]/.test(file.text))
      .map((file) => file.path);

    expect(readers.filter((path) => !path.startsWith("src/config/"))).toEqual([]);
  });
});
