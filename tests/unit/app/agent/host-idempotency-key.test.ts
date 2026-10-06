import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { withHostIdempotencyKey } from "../../../../src/app/agent/host-idempotency-key.js";
import type { JsonObject } from "../../../../src/domain/json-value.js";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from "../../../../src/domain/note.js";

/** The documented derivation, computed independently of the implementation. */
function expectedKey(turnId: string, toolName: string, canonical: string): string {
  return createHash("sha256")
    .update(`${turnId}\u0000${toolName}\u0000${canonical}`, "utf8")
    .digest("base64url");
}

const injectedSchema = z.object({ idempotencyKey: z.string() });

function keyOf(turnId: string, toolName: string, args: JsonObject): string {
  return injectedSchema.parse(withHostIdempotencyKey(turnId, toolName, args)).idempotencyKey;
}

describe("withHostIdempotencyKey", () => {
  it("derives the documented SHA-256 key over turn, tool, and canonical arguments", () => {
    expect(keyOf("turn-1", "create_note", { text: "milk" })).toBe(
      expectedKey("turn-1", "create_note", '{"text":"milk"}'),
    );
  });

  it("produces 43 base64url characters that satisfy the note key contract", () => {
    const key = keyOf("turn-1", "create_note", { text: "milk" });

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(key).toMatch(IDEMPOTENCY_KEY_PATTERN);
    expect(key.length).toBeGreaterThanOrEqual(IDEMPOTENCY_KEY_MIN_LENGTH);
    expect(key.length).toBeLessThanOrEqual(IDEMPOTENCY_KEY_MAX_LENGTH);
  });

  it("canonicalises nested objects and arrays: sorted keys at every depth, array order kept", () => {
    const args = {
      zeta: [{ b: 2, a: [{ y: null, x: true }] }, "s", -0, 1.5],
      alpha: { nested: { d: "4", c: [3, { f: 1, e: 0 }] } },
    };

    expect(keyOf("turn-1", "tool", args)).toBe(
      expectedKey(
        "turn-1",
        "tool",
        '{"alpha":{"nested":{"c":[3,{"e":0,"f":1}],"d":"4"}},' +
          '"zeta":[{"a":[{"x":true,"y":null}],"b":2},"s",0,1.5]}',
      ),
    );
  });

  it("ignores object key order at every depth", () => {
    const first = { a: 1, b: { c: [{ d: 1, e: 2 }], f: "g" } };
    const second = { b: { f: "g", c: [{ e: 2, d: 1 }] }, a: 1 };

    expect(keyOf("turn-1", "tool", first)).toBe(keyOf("turn-1", "tool", second));
  });

  it("sorts keys by UTF-16 code units", () => {
    expect(keyOf("turn-1", "tool", { é: 1, z: 2, Z: 3 })).toBe(
      expectedKey("turn-1", "tool", '{"Z":3,"z":2,"é":1}'),
    );
  });

  it.each([
    ["array order", { list: [1, 2] }, { list: [2, 1] }],
    ["a nested value", { a: { b: [{ c: 1 }] } }, { a: { b: [{ c: 2 }] } }],
    ["a value type", { a: 1 }, { a: "1" }],
    ["an extra property", { a: 1 }, { a: 1, b: null }],
  ])("derives a different key when %s changes", (_change, first, second) => {
    expect(keyOf("turn-1", "tool", first)).not.toBe(keyOf("turn-1", "tool", second));
  });

  it("derives a different key for a different turn or tool, and the same key otherwise", () => {
    const args = { text: "milk" };
    const key = keyOf("turn-1", "create_note", args);

    expect(keyOf("turn-1", "create_note", { text: "milk" })).toBe(key);
    expect(keyOf("turn-2", "create_note", args)).not.toBe(key);
    expect(keyOf("turn-1", "other_tool", args)).not.toBe(key);
  });

  it("ignores and replaces any idempotencyKey the model sent", () => {
    const derived = keyOf("turn-1", "create_note", { text: "milk" });

    for (const modelKey of ["model-chosen-key-0001", "", null, 42, { nested: true }]) {
      const injected = withHostIdempotencyKey("turn-1", "create_note", {
        text: "milk",
        idempotencyKey: modelKey,
      });

      expect(injected).toEqual({ text: "milk", idempotencyKey: derived });
    }
  });

  it("returns a new object and never mutates the model's arguments", () => {
    const args: JsonObject = Object.freeze({
      text: "milk",
      idempotencyKey: "model-key",
      meta: Object.freeze({ tags: Object.freeze(["a"]) }),
    });

    const before = JSON.stringify(args);

    const injected = withHostIdempotencyKey("turn-1", "create_note", args);

    expect(injected).not.toBe(args);
    expect(JSON.stringify(args)).toBe(before);
    expect(injected).toEqual({
      text: "milk",
      meta: { tags: ["a"] },
      idempotencyKey: keyOf("turn-1", "create_note", { meta: { tags: ["a"] }, text: "milk" }),
    });
  });
});
