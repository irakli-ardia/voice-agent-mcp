#!/usr/bin/env node
// Keeps the published documentation honest:
//   - no unresolved scaffold placeholders or FILL markers
//   - every relative Markdown link points at a real, published file, and every #anchor at a real
//     heading (a link to a git-ignored file would be broken for everyone who clones the repo)
//
//   docs-check.mjs [--root <dir>] [--include <path>...]
//
// Checks the Markdown files git publishes (tracked plus untracked-but-not-ignored). --include adds
// local files or directories to check; their links may point at unpublished files.
//
// Runs under both Node and Bun; no dependencies.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", "temp"]);

// Leftover scaffold syntax: variables, if/unless/each block tags, and else.
const PLACEHOLDER = /\{\{(?:[A-Z][A-Z0-9_]*|[#/](?:if|unless|each)\b[^}]*|else)\}\}/;

const FILL_MARKER = "<!-" + "- FILL";

const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

const HTML_ANCHOR = /<a\s+(?:id|name)="([^"]+)"/g;

const INLINE_CODE = /`[^`]*`/g;

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function isFence(line) {
  const trimmed = line.trimStart();

  return trimmed.startsWith("```") || trimmed.startsWith("~~~");
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function parseArgs(argv) {
  const args = { root: process.cwd(), include: [] };
  let including = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--root") {
      args.root = argv[++index];
      including = false;
    } else if (arg === "--include") {
      including = true;
    } else if (including && !arg.startsWith("--")) {
      args.include.push(arg);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return { ...args, root: resolve(args.root) };
}

function walkMarkdown(directory) {
  const found = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);

    if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) {
      found.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      found.push(full);
    }
  }

  return found;
}

// Repo-relative paths git would publish, or null outside a git repository.
function publishedPaths(root) {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8" },
  );

  if (result.status !== 0) {
    return null;
  }

  return new Set(
    result.stdout.split("\0").filter((path) => path !== "" && existsSync(join(root, path))),
  );
}

function isPublished(published, root, destination) {
  const rel = toPosix(relative(root, destination));

  if (rel === "" || rel.startsWith("..")) {
    return true;
  }

  if (published.has(rel)) {
    return true;
  }

  const prefix = `${rel}/`;

  return [...published].some((path) => path.startsWith(prefix));
}

function slugify(text) {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll("`", "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replaceAll(" ", "-");
}

const anchorCache = new Map();

function anchorsOf(file) {
  const cached = anchorCache.get(file);

  if (cached) {
    return cached;
  }

  const anchors = new Set();
  const counts = new Map();
  let fenced = false;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (isFence(line)) {
      fenced = !fenced;
      continue;
    }

    if (fenced) {
      continue;
    }

    const heading = HEADING.exec(line);

    if (heading) {
      const base = slugify(heading[2] ?? "");
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      anchors.add(seen === 0 ? base : `${base}-${seen}`);
    }

    for (const match of line.matchAll(HTML_ANCHOR)) {
      anchors.add(match[1]);
    }
  }

  anchorCache.set(file, anchors);

  return anchors;
}

// `published` is null for included local files: their links may point at unpublished files.
function checkLink(root, file, target, published) {
  if (EXTERNAL.test(target)) {
    return null;
  }

  const hashIndex = target.indexOf("#");
  const pathPart = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
  const anchor = hashIndex >= 0 ? safeDecode(target.slice(hashIndex + 1)) : "";
  const decoded = safeDecode(pathPart);

  if (anchor === null || decoded === null) {
    return `malformed link: ${target}`;
  }

  let destination = file;

  if (decoded.length > 0) {
    destination = decoded.startsWith("/") ? join(root, decoded) : resolve(dirname(file), decoded);
  }

  if (!existsSync(destination)) {
    return `broken link: ${target}`;
  }

  if (published !== null && !isPublished(published, root, destination)) {
    return `link to a git-ignored file (broken for anyone who clones the repo): ${target}`;
  }

  if (anchor && destination.endsWith(".md") && statSync(destination).isFile()) {
    if (!anchorsOf(destination).has(anchor.toLowerCase())) {
      return `missing anchor: ${target}`;
    }
  }

  return null;
}

function checkFile(root, file, errors, published) {
  const rel = toPosix(relative(root, file));
  const lines = readFileSync(file, "utf8").split("\n");
  let fenced = false;

  lines.forEach((line, index) => {
    const where = `${rel}:${index + 1}`;

    if (line.includes(FILL_MARKER)) {
      errors.push(`${where} — unfilled FILL marker`);
    }

    const placeholder = PLACEHOLDER.exec(line);

    if (placeholder) {
      errors.push(`${where} — unresolved placeholder ${placeholder[0]}`);
    }

    if (isFence(line)) {
      fenced = !fenced;

      return;
    }

    if (fenced) {
      return;
    }

    for (const match of line.replace(INLINE_CODE, "").matchAll(LINK)) {
      const problem = checkLink(root, file, match[1] ?? "", published);

      if (problem) {
        errors.push(`${where} — ${problem}`);
      }
    }
  });
}

function main() {
  const { root, include } = parseArgs(process.argv.slice(2));
  const published = publishedPaths(root);

  const publicFiles =
    published === null
      ? walkMarkdown(root)
      : [...published].flatMap((path) => (path.endsWith(".md") ? [join(root, path)] : []));

  const includedFiles = include.flatMap((path) => {
    const full = resolve(root, path);

    if (!existsSync(full)) {
      return [];
    }

    return statSync(full).isDirectory() ? walkMarkdown(full) : [full];
  });

  const errors = [];

  const targets = [
    ...publicFiles.map((file) => ({ file, published })),
    ...includedFiles.map((file) => ({ file, published: null })),
  ];

  for (const { file, published: scope } of targets) {
    checkFile(root, file, errors, scope);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }

    console.error(`\ndocs-check: ${errors.length} problem(s) in ${targets.length} Markdown files`);
    process.exit(1);
  }

  console.log(`docs-check: ${targets.length} Markdown files OK`);
}

try {
  main();
} catch (error) {
  console.error(`[docs-check] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
