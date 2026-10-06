/**
 * The only accepted form of a tool call id. Ids come from a model or an MCP client, so the agent
 * runner rejects a model step whose ids do not match, and the executor logs an id only in this form.
 */
export const TOOL_CALL_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
