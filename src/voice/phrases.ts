export interface Phrase {
  id: string;
  text: string;
}

/** Hard limits so one invocation can never cost more than a few cents of Polly time. */
export const MAX_PHRASES = 200;
export const MAX_CHARACTERS = 10_000;
const MAX_LINE = 300;

/** Checks the line list sent by the deploy workflow; returns the phrases or throws with the reason. */
export function validatePhrases(input: unknown): Phrase[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error('phrases must be a non-empty array');
  if (input.length > MAX_PHRASES) throw new Error(`at most ${MAX_PHRASES} phrases per run`);
  const seen = new Set<string>();
  let characters = 0;
  const phrases = input.map((item, i) => {
    const { id, text } = (item ?? {}) as Partial<Phrase>;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) throw new Error(`phrase ${i}: id must be 1-64 of a-z, 0-9, -`);
    if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_LINE) throw new Error(`phrase ${i}: text must be 1-${MAX_LINE} characters`);
    if (seen.has(id)) throw new Error(`phrase ${i}: duplicate id ${id}`);
    seen.add(id);
    characters += text.length;
    return { id, text };
  });
  if (characters > MAX_CHARACTERS) throw new Error(`at most ${MAX_CHARACTERS} characters per run (got ${characters})`);
  return phrases;
}
