import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentRunner, createAgentRunner } from "../../src/app/agent/agent-runner.js";
import { createApplication } from "../../src/bootstrap/create-application.js";
import type { JsonObject } from "../../src/domain/json-value.js";
import { ok } from "../../src/domain/result.js";
import type { ModelRequest } from "../../src/ports/agent-model.js";
import {
  continuationToken,
  createFakeAgentModel,
  type FakeAgentModel,
  type FakeContinuation,
  type FakeReply,
  step,
  toolCall,
} from "../helpers/fake-agent-model.js";
import { createFakeClock } from "../helpers/fake-clock.js";
import { createFakeIdGenerator } from "../helpers/fake-id-generator.js";
import { createRecordingLogger } from "../helpers/recording-logger.js";
import { testConfig } from "../helpers/test-config.js";

/**
 * A whole turn with no provider: the fake model drives the real composition root's registry,
 * executor, and file note store in a temporary DATA_DIR.
 */
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "agent-turn-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function runnerFor(model: FakeAgentModel): AgentRunner {
  const application = createApplication(testConfig({ dataDir }));

  return createAgentRunner({
    model,
    registry: application.tools,
    executeTool: application.executeTool,
    ids: createFakeIdGenerator(),
    clock: createFakeClock(),
    logger: createRecordingLogger(),
    limits: application.config.agent,
  });
}

async function noteFiles(): Promise<string[]> {
  return readdir(join(dataDir, "notes"));
}

/** The `ok` value of the tool result for `callId` in the request's transcript. */
function resultValue(
  request: ModelRequest<FakeContinuation>,
  callId: string,
): JsonObject | undefined {
  const item = request.transcript.find(
    (entry) => entry.kind === "tool_result" && entry.callId === callId,
  );

  return item?.kind === "tool_result" && item.result.ok ? item.result.value : undefined;
}

const createdNoteSchema = z.object({ noteId: z.string() });

function noteIdIn(value: JsonObject | undefined): string {
  const parsed = createdNoteSchema.safeParse(value);

  return parsed.success ? parsed.data.noteId : "missing";
}

/** Reads the note id created by `createCallId`, then asks to read that note. */
function readCreatedNote(createCallId: string, readCallId: string): FakeReply {
  return async (request, _signal, index) =>
    ok({
      text: null,
      toolCalls: [
        toolCall(readCallId, "read_note", {
          noteId: noteIdIn(resultValue(request, createCallId)),
        }),
      ],
      continuation: continuationToken(index),
    });
}

describe("agent turn end to end (fake model, real tools and store)", () => {
  it("creates a note, reads it back, and answers", async () => {
    const model = createFakeAgentModel([
      step(null, [toolCall("c1", "create_note", { text: "buy milk" })]),
      readCreatedNote("c1", "c2"),
      step("Saved your note: buy milk."),
    ]);

    const result = await runnerFor(model)("Remember to buy milk.", new AbortController().signal);

    expect(result).toEqual({ ok: true, value: "Saved your note: buy milk." });
    expect(await noteFiles()).toHaveLength(1);

    const last = model.requests[2];
    expect(last === undefined ? undefined : resultValue(last, "c2")).toEqual(
      expect.objectContaining({ text: "buy milk" }),
    );
  });

  it("treats identical writes within one turn as one operation", async () => {
    const model = createFakeAgentModel([
      step(null, [
        toolCall("c1", "create_note", { text: "buy milk" }),
        toolCall("c2", "create_note", { text: "buy milk" }),
      ]),
      step("Done."),
    ]);

    await runnerFor(model)("Save it twice.", new AbortController().signal);

    const request = model.requests[1];
    const first = request === undefined ? undefined : resultValue(request, "c1");
    const second = request === undefined ? undefined : resultValue(request, "c2");

    expect(first).toEqual(expect.objectContaining({ created: true }));
    expect(second).toEqual(expect.objectContaining({ created: false, noteId: noteIdIn(first) }));
    expect(await noteFiles()).toHaveLength(1);
  });

  it("derives a new key per turn, even when the model repeats its own key", async () => {
    const modelKey = "model-chosen-key-0001";

    const replies = [
      step(null, [toolCall("c1", "create_note", { text: "buy milk", idempotencyKey: modelKey })]),
      step("Done."),
    ];

    const model = createFakeAgentModel([...replies, ...replies]);
    const run = runnerFor(model);

    await run("Save it.", new AbortController().signal);
    await run("Save it again.", new AbortController().signal);

    expect(await noteFiles()).toHaveLength(2);
  });

  it("never shows the model the host-owned key in its tools", async () => {
    const model = createFakeAgentModel([step("Hi.")]);

    await runnerFor(model)("Hello.", new AbortController().signal);

    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      "get_current_time",
      "calculate",
      "create_note",
      "read_note",
    ]);
    expect(JSON.stringify(model.requests[0]?.tools)).not.toContain("idempotencyKey");
  });
});
