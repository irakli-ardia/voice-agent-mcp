/** The call a grant is for. Both must match: a grant for one call is not a grant for another. */
export interface ConfirmationScope {
  readonly toolName: string;
  readonly toolCallId: string;
}

/**
 * Host-issued approval for one tool call. Only trusted application code constructs one, and the
 * executor accepts nothing else: an `instanceof` check, which text, JSON, a model's output, an MCP
 * request or its `_meta` can never satisfy, because none of them can carry an instance.
 *
 * - **Scoped:** it covers exactly the tool name and call id it was made for.
 * - **Single use:** the executor consumes it when it is about to invoke the handler, so the same
 *   grant, passed again, approves nothing, even for the same call.
 * - **Held by the call:** no registry, cache, or global; a grant lives only as long as the call
 *   object that carries it.
 */
export class ConfirmationGrant {
  readonly #scope: ConfirmationScope;

  #consumed = false;

  constructor(scope: ConfirmationScope) {
    this.#scope = { toolName: scope.toolName, toolCallId: scope.toolCallId };
  }

  /** Whether this grant is unused and was made for exactly this call. */
  covers(call: { readonly id: string; readonly name: string }): boolean {
    return (
      !this.#consumed && call.name === this.#scope.toolName && call.id === this.#scope.toolCallId
    );
  }

  /** Spends the grant for `call`: true once, and only if it covers the call. */
  consume(call: { readonly id: string; readonly name: string }): boolean {
    if (!this.covers(call)) {
      return false;
    }

    this.#consumed = true;

    return true;
  }
}
