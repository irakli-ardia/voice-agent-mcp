import { describe, expect, it } from "vitest";
import { productionComposition } from "../../../src/bootstrap/composition.js";
import { createApplication } from "../../../src/bootstrap/create-application.js";
import { testConfig } from "../../helpers/test-config.js";

describe("productionComposition", () => {
  it("builds the application with the canonical composition root", () => {
    expect(productionComposition.createApplication).toBe(createApplication);
  });

  it("composes an agent from credentials without any I/O or request", () => {
    const application = createApplication(testConfig({ dataDir: "never-written-data-dir" }));

    const runTurn = productionComposition.createAgent(application, { apiKey: "sk-test-key" });

    expect(runTurn).toBeInstanceOf(Function);
  });
});
