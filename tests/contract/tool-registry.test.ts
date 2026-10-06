import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createModelTools } from "../../src/app/agent/model-tools.js";
import { createApplication } from "../../src/bootstrap/create-application.js";
import {
  MAX_TOOL_ERROR_MESSAGE_JSON_BYTES,
  toolErrorMessageJsonBytes,
} from "../../src/domain/tool-execution-error.js";
import type { ToolDefinition } from "../../src/tools/tool-definition.js";
import { testConfig } from "../helpers/test-config.js";

/**
 * Contract for every tool in the real registry, as the composition root builds it. Schemas are
 * checked through the JSON Schema that OpenAI (M3) and MCP (M5) will derive from them.
 */
const { tools } = createApplication(
  testConfig({ dataDir: "contract-test-data-dir-never-written" }),
);

const schemaBranch = z.looseObject({
  type: z.string().optional(),
  maxLength: z.number().optional(),
  enum: z.array(z.unknown()).optional(),
});

const propertySchema = z.looseObject({
  ...schemaBranch.shape,
  description: z.string().optional(),
  anyOf: z.array(schemaBranch).optional(),
});

const strictObjectSchema = z.looseObject({
  type: z.literal("object"),
  additionalProperties: z.literal(false),
  properties: z.record(z.string(), propertySchema),
  required: z.array(z.string()),
});

type JsonSchemaProperty = z.output<typeof propertySchema>;

/** A string branch is bounded by a maximum length or by a finite set of values. */
function hasUnboundedString(property: JsonSchemaProperty): boolean {
  return [property, ...(property.anyOf ?? [])].some(
    (branch) =>
      branch.type === "string" && branch.maxLength === undefined && branch.enum === undefined,
  );
}

function inputJsonSchema(tool: ToolDefinition): z.output<typeof strictObjectSchema> {
  return strictObjectSchema.parse(z.toJSONSchema(tool.inputSchema, { io: "input" }));
}

describe("tool registry contract", () => {
  it("registers at least one tool and every name once", () => {
    const names = tools.tools.map((tool) => tool.name);

    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes at least one write tool, so the write-tool contract below cannot pass vacuously", () => {
    expect(tools.tools.some((tool) => tool.risk === "write")).toBe(true);
  });

  /**
   * A write retried after `timed_out` or `cancelled` must not repeat its effect, so every write
   * tool names its operation with a required, non-null, bounded key.
   */
  describe.each(tools.tools.filter((tool) => tool.risk === "write"))("write tool $name", (tool) => {
    it("takes a required, non-null, bounded idempotencyKey string", () => {
      const {
        required,
        properties: { idempotencyKey },
      } = inputJsonSchema(tool);

      expect(required).toContain("idempotencyKey");
      expect(idempotencyKey).toEqual(
        expect.objectContaining({ type: "string", maxLength: expect.any(Number) }),
      );
      expect(idempotencyKey?.anyOf).toBeUndefined();
    });
  });

  it("marks create_note as a key tool, so the agent host owns its key", () => {
    expect(tools.find("create_note")?.idempotency).toBe("key");
  });

  /** Host-owned fields are hidden from the model; everything else reaches it unchanged. */
  describe.each(createModelTools(tools.tools))("model-facing $name", (modelTool) => {
    const tool = tools.find(modelTool.name);
    const hostOwned = tool?.idempotency === "key" ? ["idempotencyKey"] : [];

    it("exposes exactly the canonical properties minus host-owned fields", () => {
      const canonical = tool === undefined ? [] : Object.keys(inputJsonSchema(tool).properties);
      const projected = Object.keys(strictObjectSchema.parse(modelTool.parameters).properties);

      expect(projected.sort()).toEqual(canonical.filter((key) => !hostOwned.includes(key)).sort());
      expect(JSON.stringify(modelTool)).not.toContain("idempotencyKey");
    });
  });

  describe.each(tools.tools)("$name", (tool) => {
    it("declares idempotency key exactly when its input takes an idempotencyKey", () => {
      const takesKey = Object.keys(inputJsonSchema(tool).properties).includes("idempotencyKey");

      expect(tool.idempotency === "key").toBe(takesKey);
    });

    it("keeps every failure message within the serialised byte bound", () => {
      for (const failure of tool.failures) {
        expect(toolErrorMessageJsonBytes(failure.message)).toBeLessThanOrEqual(
          MAX_TOOL_ERROR_MESSAGE_JSON_BYTES,
        );
      }
    });

    it("has a description for model selection", () => {
      expect(tool.description.trim().length).toBeGreaterThan(20);
    });

    it("requires confirmation if it is destructive", () => {
      expect(tool.risk !== "destructive" || tool.requiresConfirmation).toBe(true);
    });

    it("declares its expected failures with snake_case reasons and non-empty messages", () => {
      for (const failure of tool.failures) {
        expect(failure.reason).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(failure.message.trim().length).toBeGreaterThan(0);
      }
    });

    it("takes a strict object whose properties are all required and described", () => {
      const schema = inputJsonSchema(tool);
      const properties = Object.entries(schema.properties);

      expect([...schema.required].sort()).toEqual(properties.map(([key]) => key).sort());

      for (const [, property] of properties) {
        expect(property.description?.trim().length ?? 0).toBeGreaterThan(0);
      }
    });

    it("bounds every string argument", () => {
      const unbounded = Object.entries(inputJsonSchema(tool).properties).flatMap(
        ([key, property]) => (hasUnboundedString(property) ? [key] : []),
      );

      expect(unbounded).toEqual([]);
    });

    it("returns a strict object that JSON Schema can express", () => {
      expect(() =>
        strictObjectSchema.parse(z.toJSONSchema(tool.outputSchema, { io: "output" })),
      ).not.toThrow();
    });
  });
});
