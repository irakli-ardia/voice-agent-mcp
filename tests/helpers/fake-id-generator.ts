import type { IdGenerator } from "../../src/ports/id-generator.js";

/** Deterministic ids: `turn-1`, `turn-2`, … */
export function createFakeIdGenerator(prefix = "turn"): IdGenerator {
  let issued = 0;

  return {
    newId: (): string => {
      issued += 1;

      return `${prefix}-${issued}`;
    },
  };
}
