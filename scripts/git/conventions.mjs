#!/usr/bin/env node
// Branch, commit-subject, and PR-title conventions (CONTRIBUTING.md → Branches and commits).
//
//   conventions.mjs branch <name>
//   conventions.mjs title <subject>
//   conventions.mjs commits <base> <head>
//   conventions.mjs current [base-ref]      current branch + its commits since base
//   conventions.mjs install-hooks           point git at .githooks/ (run from "prepare")
//
// Runs under both Node and Bun; no dependencies.

import { spawnSync } from "node:child_process";

const DEFAULT_BRANCH = "main";

const DEFAULT_BASE_REF = `origin/${DEFAULT_BRANCH}`;

const MAX_SUBJECT_LENGTH = 72;

const BRANCH_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "hotfix",
  "perf",
  "refactor",
  "release",
  "revert",
  "test",
]);

const COMMIT_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "test",
]);

const EXEMPT_BRANCH_PREFIXES = ["dependabot/", "renovate/"];

// Subjects git and GitHub generate themselves. One list, so the commit-msg hook, the pre-push
// check, and CI never disagree about what may be committed versus pushed.
const EXEMPT_SUBJECT_PREFIXES = [
  "Merge branch ",
  "Merge pull request ",
  "Merge remote-tracking branch ",
  'Revert "',
  "fixup! ",
  "squash! ",
  "amend! ",
];

function isKebabCase(value) {
  if (value.length === 0 || value.startsWith("-") || value.endsWith("-") || value.includes("--")) {
    return false;
  }

  for (const character of value) {
    const isLower = character >= "a" && character <= "z";
    const isDigit = character >= "0" && character <= "9";

    if (!isLower && !isDigit && character !== "-") {
      return false;
    }
  }

  return true;
}

function isExemptBranch(branch) {
  return (
    branch === DEFAULT_BRANCH || EXEMPT_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))
  );
}

function validateBranch(branch) {
  if (isExemptBranch(branch)) {
    return null;
  }

  const separator = branch.indexOf("/");

  if (separator <= 0 || separator !== branch.lastIndexOf("/")) {
    return "branch must use <type>/<kebab-case-description>";
  }

  const type = branch.slice(0, separator);

  if (!BRANCH_TYPES.has(type)) {
    return `unsupported branch type '${type}' (allowed: ${[...BRANCH_TYPES].join(", ")})`;
  }

  if (!isKebabCase(branch.slice(separator + 1))) {
    return "branch description must be lowercase kebab-case";
  }

  return null;
}

function validateTitle(subject) {
  if (EXEMPT_SUBJECT_PREFIXES.some((prefix) => subject.startsWith(prefix))) {
    return null;
  }

  if (subject.length > MAX_SUBJECT_LENGTH) {
    return `subject must be ${MAX_SUBJECT_LENGTH} characters or fewer (has ${subject.length})`;
  }

  if (subject.endsWith(".")) {
    return "subject must not end with a period";
  }

  const separator = subject.indexOf(": ");

  if (separator <= 0) {
    return "subject must use <type>(optional-scope): summary";
  }

  const summary = subject.slice(separator + 2);
  const first = summary[0] ?? "";

  if (!((first >= "a" && first <= "z") || (first >= "0" && first <= "9"))) {
    return "summary must start with a lowercase letter or a digit";
  }

  let header = subject.slice(0, separator);

  if (header.endsWith("!")) {
    header = header.slice(0, -1);
  }

  let type = header;
  const scopeStart = header.indexOf("(");

  if (scopeStart >= 0) {
    if (!header.endsWith(")")) {
      return "scope must be enclosed in parentheses";
    }

    type = header.slice(0, scopeStart);

    if (!isKebabCase(header.slice(scopeStart + 1, -1))) {
      return "scope must be lowercase kebab-case";
    }
  }

  if (!COMMIT_TYPES.has(type)) {
    return `unsupported type '${type}' (allowed: ${[...COMMIT_TYPES].join(", ")})`;
  }

  return null;
}

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });

  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim(),
  };
}

function subjectsBetween(base, head) {
  const result = git(["log", "--no-merges", "--format=%s", `${base}..${head}`]);

  if (!result.ok) {
    throw new Error(result.err || `unable to read commits ${base}..${head}`);
  }

  return result.out.split("\n").filter((subject) => subject.trim().length > 0);
}

function resolveBase(explicit) {
  const candidates = explicit ? [explicit] : [DEFAULT_BASE_REF, DEFAULT_BRANCH];

  for (const ref of candidates) {
    if (git(["rev-parse", "--verify", "--quiet", ref]).ok) {
      return ref;
    }
  }

  return null;
}

function check(label, value, reason) {
  if (reason) {
    throw new Error(`${label} '${value}' is invalid: ${reason}`);
  }
}

function checkCurrent(explicitBase) {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (!branch.ok) {
    return;
  }

  check("branch", branch.out, validateBranch(branch.out));

  if (isExemptBranch(branch.out)) {
    return;
  }

  const base = resolveBase(explicitBase);

  if (!base) {
    console.warn(`[git conventions] no ${DEFAULT_BASE_REF} yet; checked the branch name only`);

    return;
  }

  for (const subject of subjectsBetween(base, "HEAD")) {
    check("commit subject", subject, validateTitle(subject));
  }
}

function installHooks() {
  if (!git(["rev-parse", "--git-dir"]).ok) {
    return;
  }

  const result = git(["config", "core.hooksPath", ".githooks"]);

  if (!result.ok) {
    throw new Error(result.err || "unable to configure git hooks");
  }
}

function run([command, ...values]) {
  if (command === "branch" && values.length === 1) {
    check("branch", values[0], validateBranch(values[0]));
  } else if (command === "title" && values.length === 1) {
    check("title", values[0], validateTitle(values[0]));
  } else if (command === "commits" && values.length === 2) {
    for (const subject of subjectsBetween(values[0], values[1])) {
      check("commit subject", subject, validateTitle(subject));
    }
  } else if (command === "current" && values.length <= 1) {
    checkCurrent(values[0]);
  } else if (command === "install-hooks" && values.length === 0) {
    installHooks();
  } else {
    throw new Error("usage: conventions.mjs <branch|title|commits|current|install-hooks> [args]");
  }
}

try {
  run(process.argv.slice(2));
} catch (error) {
  console.error(`[git conventions] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
