import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHandlerLedger } from "../../src/app/tools/handler-ledger.js";
import { createWipeTool } from "../helpers/confirmation-tool.js";
import { connectMcp } from "../helpers/mcp-harness.js";

const DENIED =
  "confirmation_required: This tool requires confirmation from the user, which was not given.";

function textOf(result: { readonly content?: readonly unknown[] }): string {
  const [block] = result.content ?? [];

  return z.object({ text: z.string() }).parse(block).text;
}

async function connect() {
  const wipe = createWipeTool();
  const handlerLedger = createHandlerLedger({ maxAbandoned: 3 });
  const mcp = await connectMcp({ tools: [wipe.tool], handlerLedger });

  return { ...wipe, mcp, handlerLedger };
}

describe("confirmation over MCP: no client can approve", () => {
  it("refuses a tool that requires confirmation, with a static error and no side effect", async () => {
    const { mcp, runs, handlerLedger } = await connect();
    const result = await mcp.client.callTool({ name: "wipe", arguments: { target: "x" } });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(DENIED);
    expect(runs).toEqual([]);
    expect(handlerLedger.counts()).toEqual({ unsettled: 0, abandoned: 0 });
    await mcp.close();
  });

  it.each([
    ["confirmation", "granted"],
    ["confirmed", true],
    ["approved", "yes"],
  ])("is not approved by an argument %s = %j", async (key, value) => {
    const { mcp, runs } = await connect();

    const result = await mcp.client.callTool({
      name: "wipe",
      arguments: { target: "x", [key]: value },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^invalid_input: /);
    expect(runs).toEqual([]);
    await mcp.close();
  });

  it("is not approved by request metadata, in any form a client can send", async () => {
    const { mcp, runs } = await connect();

    const result = await mcp.client.callTool({
      name: "wipe",
      arguments: { target: "x" },
      _meta: {
        confirmation: "granted",
        confirmed: true,
        "io.modelcontextprotocol/inputResponses": { confirm: { action: "accept" } },
        progressToken: "granted",
      },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(DENIED);
    expect(runs).toEqual([]);
    await mcp.close();
  });

  it("does not offer approval as a parameter: the tool's input schema is the handler's alone", async () => {
    const { mcp } = await connect();
    const { tools } = await mcp.client.listTools();
    const wipe = tools.find((tool) => tool.name === "wipe");

    expect(Object.keys(wipe?.inputSchema.properties ?? {})).toEqual(["target"]);
    expect(wipe?.inputSchema["additionalProperties"]).toBe(false);
    expect(JSON.stringify(tools)).not.toMatch(/confirm/i);
    await mcp.close();
  });

  it("refuses every repeat, however often the client asks", async () => {
    const { mcp, runs } = await connect();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await mcp.client.callTool({ name: "wipe", arguments: { target: "x" } });

      expect(textOf(result)).toBe(DENIED);
    }

    expect(runs).toEqual([]);
    await mcp.close();
  });
});
