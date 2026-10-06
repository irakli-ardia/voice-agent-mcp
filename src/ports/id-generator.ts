/** Source of unique, opaque identifiers (such as a turn id). */
export interface IdGenerator {
  newId(): string;
}
