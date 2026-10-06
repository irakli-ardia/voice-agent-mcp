import { describe, expect, it } from "vitest";
import { readRootTypeScriptFiles, readTypeScriptFiles } from "../helpers/source-files.js";

/**
 * Repository invariant on top of Biome and oxlint: these escapes may not appear in first-party
 * TypeScript. The patterns are written so that this file does not match itself.
 */
const FORBIDDEN = [
  { name: "explicit any annotation", pattern: /:\s*any\b/ },
  { name: "angle-bracket any", pattern: /<\s*any\s*>/ },
  { name: "cast to any", pattern: /\bas\s+any\b/ },
  { name: "double cast through unknown", pattern: /\bas\s+unknown\s+as\b/ },
  { name: "ts-ignore directive", pattern: /@ts-(?:ignore)\b/ },
  { name: "ts-nocheck directive", pattern: /@ts-(?:nocheck)\b/ },
];

/**
 * Justified exceptions: repo-relative path → reason. Each entry also needs a note in
 * docs/coding-standards.md (TypeScript → approved exceptions). Empty by design.
 */
const ALLOWED: ReadonlyMap<string, string> = new Map();

function findEscapes(path: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, index) =>
      FORBIDDEN.flatMap(({ name, pattern }) =>
        pattern.test(line) ? [`${path}:${index + 1} ${name}`] : [],
      ),
    );
}

describe("forbidden type escapes", () => {
  it("detects each forbidden pattern", () => {
    const sample = [
      ["const a", "any = 1;"].join(": "),
      ["const b = <", "any>c;"].join(""),
      ["const d = e as", "any;"].join(" "),
      ["const f = g as", "unknown as", "H;"].join(" "),
      ["// @ts", "ignore"].join("-"),
      ["// @ts", "nocheck"].join("-"),
    ].join("\n");

    expect(findEscapes("sample.ts", sample)).toHaveLength(FORBIDDEN.length);
  });

  it("finds none in src, tests, or root config files", () => {
    const escapes = [...readTypeScriptFiles("src", "tests"), ...readRootTypeScriptFiles()]
      .filter((file) => !ALLOWED.has(file.path))
      .flatMap((file) => findEscapes(file.path, file.text));

    expect(escapes).toEqual([]);
  });
});
