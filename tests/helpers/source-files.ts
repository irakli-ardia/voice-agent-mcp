import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

export interface SourceFile {
  /** Repo-relative path with forward slashes, e.g. `src/config/config.ts`. */
  readonly path: string;
  readonly text: string;
}

function toSourceFile(file: string): SourceFile {
  return {
    path: relative(REPO_ROOT, file).split(sep).join("/"),
    text: readFileSync(file, "utf8"),
  };
}

/** Every `.ts` file under the given repo-relative directories, recursively. */
export function readTypeScriptFiles(...dirs: readonly string[]): SourceFile[] {
  return dirs.flatMap((dir) => {
    const absolute = join(REPO_ROOT, dir);

    if (!existsSync(absolute)) {
      return [];
    }

    return readdirSync(absolute, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => toSourceFile(join(absolute, name)));
  });
}

/** `.ts` files directly in the repository root (tool configs such as `vitest.config.ts`). */
export function readRootTypeScriptFiles(): SourceFile[] {
  return readdirSync(REPO_ROOT, { encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"))
    .map((name) => toSourceFile(join(REPO_ROOT, name)));
}

const IMPORT_PATTERNS = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

/** Module specifiers of static imports, re-exports, side-effect imports, and dynamic imports. */
export function importSpecifiers(text: string): string[] {
  return IMPORT_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
  );
}
