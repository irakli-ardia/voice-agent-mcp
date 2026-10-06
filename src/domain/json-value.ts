/** A value that survives `JSON.stringify` unchanged: what tools return to models and MCP clients. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };
