/** A short text record created by `create_note` and read by `read_note`. Notes never change. */
export interface Note {
  readonly id: string;
  readonly text: string;
  readonly createdAt: Date;
}

/** 32 lowercase hex characters: the first 16 bytes of SHA-256 of the note's idempotency key. */
export const NOTE_ID_PATTERN = /^[0-9a-f]{32}$/;

export const NOTE_TEXT_MAX_LENGTH = 2_000;

export const IDEMPOTENCY_KEY_MIN_LENGTH = 16;

export const IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/** ASCII only, so a key's UTF-8 bytes are its characters; the note store hashes them into an id. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
