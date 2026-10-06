import { randomUUID } from "node:crypto";
import type { IdGenerator } from "../../ports/id-generator.js";

export const systemIdGenerator: IdGenerator = {
  newId: (): string => randomUUID(),
};
