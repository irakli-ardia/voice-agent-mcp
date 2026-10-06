import { z } from "zod";
import { ok } from "../../domain/result.js";
import { defineTool } from "../tool-definition.js";

/** The runtime's time zone database decides; it accepts IANA names, aliases, and offsets. */
function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });

    return true;
  } catch {
    return false;
  }
}

/** Wall-clock time in `timeZone` as `YYYY-MM-DDTHH:mm:ss`, without an offset. */
function formatLocalTime(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);

  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
}

export const getCurrentTimeTool = defineTool({
  name: "get_current_time",
  description:
    "Returns the current date and time, in UTC and as local wall-clock time in one time zone. " +
    "Use it whenever an answer depends on the current date or time; never guess them.",
  risk: "read",
  requiresConfirmation: false,
  timeoutMs: 1_000,
  inputSchema: z.strictObject({
    timeZone: z
      .string()
      .max(64)
      .refine(isKnownTimeZone, "Unknown time zone.")
      .nullable()
      .describe("IANA time zone name, such as Europe/London or Asia/Tokyo; null for UTC."),
  }),
  outputSchema: z.strictObject({
    isoTime: z.iso.datetime().describe("The current instant in UTC, ISO 8601."),
    timeZone: z.string().describe("The time zone used for localTime."),
    localTime: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
      .describe("Wall-clock time in timeZone, YYYY-MM-DDTHH:mm:ss."),
  }),
  failures: {},
  execute: async ({ timeZone }, context) => {
    const now = context.clock.now();
    const zone = timeZone ?? "UTC";

    return ok({
      isoTime: now.toISOString(),
      timeZone: zone,
      localTime: formatLocalTime(now, zone),
    });
  },
});
