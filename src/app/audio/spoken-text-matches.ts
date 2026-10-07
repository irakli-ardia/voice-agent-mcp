/** Runs of letters, combining marks, and digits: the words a listener hears. */
const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/**
 * The words of `text` with only representation-level differences removed: lower case, Unicode
 * compatibility forms (NFKC), and everything between words (spaces, punctuation, symbols). Words
 * themselves are never rewritten: digits stay digits, spellings stay spellings.
 */
function spokenWords(text: string): readonly string[] {
  // NFKC before lowering maps compatibility forms (`Ｈ`, `ℌ`) to letters lowering knows; NFKC
  // after it recomposes anything lowering decomposed, so both sides end in the same form.
  return text.normalize("NFKC").toLowerCase().normalize("NFKC").match(WORD) ?? [];
}

/**
 * Whether the speech renderer said exactly the answer, word for word. Strict and deterministic:
 * no similarity score, fuzzy match, or tolerance. A renderer that answers, rephrases, adds, drops,
 * or reorders a word fails, as does one that says "forty two" for "42".
 */
export function spokenTextMatches(answer: string, spokenText: string): boolean {
  const expected = spokenWords(answer);
  const spoken = spokenWords(spokenText);

  return (
    expected.length === spoken.length && expected.every((word, index) => word === spoken[index])
  );
}
