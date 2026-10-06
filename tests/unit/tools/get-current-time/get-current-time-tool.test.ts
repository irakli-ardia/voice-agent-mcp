import { describe, expect, it } from "vitest";
import { getCurrentTimeTool } from "../../../../src/tools/get-current-time/get-current-time-tool.js";
import { createFakeClock } from "../../../helpers/fake-clock.js";
import { runTool } from "../../../helpers/run-tool.js";

const clock = createFakeClock(new Date("2026-01-02T03:04:05.000Z"));

describe("getCurrentTimeTool", () => {
  it("returns UTC when no time zone is given", async () => {
    expect(await runTool(getCurrentTimeTool, { arguments: { timeZone: null } }, clock)).toEqual({
      ok: true,
      value: {
        isoTime: "2026-01-02T03:04:05.000Z",
        timeZone: "UTC",
        localTime: "2026-01-02T03:04:05",
      },
    });
  });

  it.each([
    ["Asia/Tokyo", "2026-01-02T12:04:05"],
    ["America/New_York", "2026-01-01T22:04:05"],
    ["Asia/Kolkata", "2026-01-02T08:34:05"],
    ["Etc/GMT+3", "2026-01-02T00:04:05"],
  ])("returns the wall-clock time in %s", async (timeZone, localTime) => {
    expect(await runTool(getCurrentTimeTool, { arguments: { timeZone } }, clock)).toEqual({
      ok: true,
      value: { isoTime: "2026-01-02T03:04:05.000Z", timeZone, localTime },
    });
  });

  it("formats midnight as hour 00", async () => {
    const midnight = createFakeClock(new Date("2026-01-02T00:00:00.000Z"));

    const result = await runTool(getCurrentTimeTool, { arguments: { timeZone: "UTC" } }, midnight);

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ localTime: "2026-01-02T00:00:00" }),
    });
  });

  it.each([
    ["an unknown time zone", { timeZone: "Mars/Olympus" }, "timeZone: Unknown time zone."],
    ["an empty time zone", { timeZone: "" }, "timeZone: Unknown time zone."],
    ["a missing time zone", {}, "timeZone: Invalid input: expected string, received undefined"],
  ])("rejects %s", async (_label, args, issue) => {
    expect(await runTool(getCurrentTimeTool, { arguments: args }, clock)).toEqual({
      ok: false,
      error: { code: "invalid_input", message: `Invalid arguments: ${issue}.` },
    });
  });

  it("rejects an overlong time zone without echoing it", async () => {
    const secret = `sk-${"z".repeat(70)}`;

    const result = await runTool(getCurrentTimeTool, { arguments: { timeZone: secret } }, clock);

    expect(result.ok ? "ok" : result.error.code).toBe("invalid_input");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
