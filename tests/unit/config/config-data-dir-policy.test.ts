import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isExplicitAbsolutePath, loadConfig } from "../../../src/config/config.js";

const SECRET = "SENTINEL-PATH-SEGMENT-7d41";

const STRICT = { dataDir: "explicit-absolute" } as const;

describe("isExplicitAbsolutePath: Windows", () => {
  it.each([
    ["a drive and a backslash", "C:\\Users\\x\\notes"],
    ["a drive and a forward slash", "C:/Users/x/notes"],
    ["a lower-case drive", "d:\\data"],
    ["a bare drive root", "C:\\"],
    ["a UNC share", "\\\\server\\share\\notes"],
    ["a bare UNC share", "\\\\server\\share"],
    ["a UNC share with forward slashes", "//server/share/notes"],
    ["a verbatim drive path", "\\\\?\\C:\\very\\long\\path"],
    ["spaces inside", "C:\\Program Files\\voice agent\\notes"],
  ])("accepts %s", (_name, value) => {
    expect(isExplicitAbsolutePath(value, "windows")).toBe(true);
  });

  it.each([
    ["a relative path", "notes\\data"],
    ["a dot path", ".data"],
    ["a parent path", "..\\notes"],
    ["the current drive's root (no drive)", "\\notes"],
    ["a drive-relative path", "C:notes"],
    ["a bare drive", "C:"],
    ["a home shorthand", "~\\notes"],
    ["a server with no share", "\\\\server"],
    ["a verbatim UNC path (unsupported)", "\\\\?\\UNC\\server\\share\\x"],
    ["a forbidden character", "C:\\notes<1>"],
    ["a question mark", "C:\\notes?"],
    ["a pipe", "C:\\a|b"],
    ["a star", "C:\\a*"],
    ["a quote", 'C:\\a"b'],
    ["a NUL byte", "C:\\notes\0"],
    ["an NTFS stream name after the drive", "C:\\data\\notes:stream"],
    ["a device namespace path", "\\\\.\\pipe\\notes"],
    ["a device namespace drive path", "//./C:/notes"],
    ["a POSIX path", "/home/x/notes"],
  ])("rejects %s", (_name, value) => {
    expect(isExplicitAbsolutePath(value, "windows")).toBe(false);
  });
});

describe("isExplicitAbsolutePath: POSIX", () => {
  it.each([
    ["a root path", "/var/lib/voice-agent"],
    ["the root", "/"],
    ["spaces and dots", "/home/me/My Notes/.data"],
    ["parent segments (they resolve)", "/home/me/../shared/notes"],
    ["a backslash (a legal file name character)", "/home/me/a\\b"],
  ])("accepts %s", (_name, value) => {
    expect(isExplicitAbsolutePath(value, "posix")).toBe(true);
  });

  it.each([
    ["a relative path", "notes/data"],
    ["a dot path", ".data"],
    ["a parent path", "../notes"],
    ["a home shorthand", "~/notes"],
    ["a Windows drive path", "C:\\notes"],
    ["a Windows drive path with a slash", "C:/notes"],
    ["a UNC path", "\\\\server\\share"],
    ["a NUL byte", "/home/x\0y"],
    ["an empty string", ""],
  ])("rejects %s", (_name, value) => {
    expect(isExplicitAbsolutePath(value, "posix")).toBe(false);
  });
});

describe("loadConfig with the explicit-absolute DATA_DIR policy", () => {
  const absolute = join(tmpdir(), "voice-agent-policy-test");

  it("accepts an absolute DATA_DIR and uses it as given", () => {
    const result = loadConfig({ DATA_DIR: absolute }, STRICT);

    expect(result.ok && result.config.dataDir).toBe(resolve(absolute));
  });

  it("refuses an unset DATA_DIR instead of defaulting to .data", () => {
    const result = loadConfig({}, STRICT);

    expect(result).toEqual({
      ok: false,
      issues: ["DATA_DIR: must be set to an absolute directory path for this command"],
    });
  });

  it.each([[""], [" "], ["   "], ["\t"], ["\n"]])("refuses the empty value %j", (value) => {
    const result = loadConfig({ DATA_DIR: value }, STRICT);

    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.join("\n")).toContain("DATA_DIR: must be set");
  });

  it.each([[".data"], ["notes"], ["./notes"], ["../notes"], ["~/notes"], ["notes/../../x"]])(
    "refuses the relative value %j and never resolves it against the working directory",
    (value) => {
      const result = loadConfig({ DATA_DIR: value }, STRICT);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.issues.join("\n")).toContain(
        "DATA_DIR: must be an absolute path",
      );
    },
  );

  it("never repeats the value, whatever it was", () => {
    for (const value of [`${SECRET}/x`, `C:${SECRET}`, SECRET, ` ${SECRET} `]) {
      const result = loadConfig({ DATA_DIR: value }, STRICT);

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("reports this problem together with the others, so one run shows them all", () => {
    const result = loadConfig({ LOG_LEVEL: "loud" }, STRICT);

    expect(!result.ok && result.issues).toEqual([
      "DATA_DIR: must be set to an absolute directory path for this command",
      expect.stringContaining("LOG_LEVEL"),
    ]);
  });

  it("still reports the other problems when DATA_DIR is fine", () => {
    const result = loadConfig({ DATA_DIR: absolute, MAX_NOTES: "0" }, STRICT);

    expect(!result.ok && result.issues).toEqual([expect.stringContaining("MAX_NOTES")]);
  });

  it("touches no file: it only reads the environment object it is given", () => {
    const empty: Record<string, string | undefined> = {};

    const env = new Proxy(empty, {
      get: (_target, key) => (key === "DATA_DIR" ? absolute : undefined),
    });

    expect(loadConfig(env, STRICT).ok).toBe(true);
  });
});

describe("loadConfig without the policy keeps the CLI's behaviour", () => {
  it("still defaults to .data resolved against the working directory", () => {
    const result = loadConfig({});

    expect(result.ok && result.config.dataDir).toBe(resolve(".data"));
  });

  it("still resolves a relative DATA_DIR against the working directory", () => {
    const result = loadConfig({ DATA_DIR: "notes" });

    expect(result.ok && result.config.dataDir).toBe(resolve("notes"));
  });

  it("is the same when the default mode is named", () => {
    expect(loadConfig({}, { dataDir: "default" })).toEqual(loadConfig({}));
  });

  it("still refuses an empty DATA_DIR, as before", () => {
    expect(loadConfig({ DATA_DIR: "" }).ok).toBe(false);
  });
});
