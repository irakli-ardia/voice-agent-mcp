import { createHash } from "node:crypto";
import { z } from "zod";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  NOTE_ID_PATTERN,
  NOTE_TEXT_MAX_LENGTH,
} from "../../domain/note.js";
import { err, ok, type Result } from "../../domain/result.js";

/** A valid record is under 13 KB; anything larger is not one and is never read into memory. */
export const MAX_RECORD_BYTES = 65_536;

const recordSchema = z.strictObject({
  noteId: z.string().regex(NOTE_ID_PATTERN),
  idempotencyKey: z
    .string()
    .min(IDEMPOTENCY_KEY_MIN_LENGTH)
    .max(IDEMPOTENCY_KEY_MAX_LENGTH)
    .regex(IDEMPOTENCY_KEY_PATTERN),
  text: z.string().min(1).max(NOTE_TEXT_MAX_LENGTH),
  createdAt: z.iso.datetime(),
});

export type NoteRecord = z.output<typeof recordSchema>;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Lowercase hex of the first 16 bytes of SHA-256 over the key's UTF-8 bytes (the key is ASCII). */
export function noteIdFor(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey, "utf8").digest("hex").slice(0, 32);
}

/** UTF-8 JSON matching the strict record schema, or why it is not one. Never throws. */
export function decodeRecord(
  bytes: Uint8Array,
): Result<NoteRecord, "invalid_json" | "invalid_record"> {
  try {
    const parsed = recordSchema.safeParse(JSON.parse(utf8.decode(bytes)));

    return parsed.success ? ok(parsed.data) : err("invalid_record");
  } catch {
    return err("invalid_json");
  }
}
