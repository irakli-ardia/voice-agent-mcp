import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../../domain/json-value.js";

/**
 * Deterministic serialisation of a JSON value: object keys sorted recursively by UTF-16 code units,
 * array order kept, scalars as `JSON.stringify` writes them. Enough to make equal arguments derive
 * equal keys; not a claim of RFC 8785 compliance.
 */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  if (value instanceof Object) {
    // Keys of one object are distinct, so the comparison never needs to report equality.
    const members = Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);

    return `{${members.join(",")}}`;
  }

  return JSON.stringify(value);
}

/**
 * Returns a copy of `args` whose `idempotencyKey` is derived by the host from the turn, the tool,
 * and the other arguments, so the model can neither choose nor influence it:
 * `base64url(SHA-256(turnId ‖ 0x00 ‖ toolName ‖ 0x00 ‖ canonicalJson(args without idempotencyKey)))`,
 * 43 characters of `[A-Za-z0-9_-]`. `args` is never mutated.
 */
export function withHostIdempotencyKey(
  turnId: string,
  toolName: string,
  args: JsonObject,
): JsonObject {
  const rest = Object.fromEntries(Object.entries(args).filter(([key]) => key !== "idempotencyKey"));

  const idempotencyKey = createHash("sha256")
    .update(`${turnId}\u0000${toolName}\u0000${canonicalJson(rest)}`, "utf8")
    .digest("base64url");

  return { ...rest, idempotencyKey };
}
