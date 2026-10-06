/** Outcome of an operation whose failure is expected and part of its contract. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** `const` keeps a literal error (a tool's failure reason) from widening to `string`. */
export function err<const E>(error: E): Result<never, E> {
  return { ok: false, error };
}
