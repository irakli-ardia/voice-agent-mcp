import { describe, expect, it } from "vitest";
import { createApplication } from "../../../src/bootstrap/create-application.js";

describe("createApplication", () => {
  it("wires a logger for the given config", () => {
    const application = createApplication({ logLevel: "silent" });
    expect(application.config).toEqual({ logLevel: "silent" });
    expect(() => application.logger.child({ turnId: "t-1" }).info("ready")).not.toThrow();
  });
});
