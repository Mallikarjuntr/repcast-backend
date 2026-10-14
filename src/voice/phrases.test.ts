import { describe, expect, it } from 'vitest';
import { MAX_CHARACTERS, MAX_PHRASES, validatePhrases } from './phrases.js';

describe('validatePhrases', () => {
  it('accepts a normal line list', () => {
    expect(validatePhrases([{ id: 'one-abc', text: 'one' }, { id: 'rest-x1', text: 'Rest. Next, squats.' }])).toHaveLength(2);
  });

  it('rejects ids that are not safe file names', () => {
    expect(() => validatePhrases([{ id: '../etc', text: 'hi' }])).toThrow(/id/);
  });

  it('rejects duplicates, empty text and empty lists', () => {
    expect(() => validatePhrases([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }])).toThrow(/duplicate/);
    expect(() => validatePhrases([{ id: 'a', text: '  ' }])).toThrow(/text/);
    expect(() => validatePhrases([])).toThrow(/non-empty/);
  });

  it('caps how much one run can synthesise', () => {
    const many = Array.from({ length: MAX_PHRASES + 1 }, (_, i) => ({ id: `p${i}`, text: 'x' }));
    expect(() => validatePhrases(many)).toThrow(/at most/);
    const long = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, text: 'y'.repeat(MAX_CHARACTERS / 35) }));
    expect(() => validatePhrases(long)).toThrow(/characters/);
  });
});
