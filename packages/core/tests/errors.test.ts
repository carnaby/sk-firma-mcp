import { describe, it, expect } from 'vitest';
import { ToolError, validateIco } from '../src/errors.js';

describe('validateIco', () => {
  it('prijme 8-miestne IČO', () => {
    expect(validateIco('12345678')).toBe('12345678');
  });
  it('normalizuje medzery', () => {
    expect(validateIco(' 12 345 678 ')).toBe('12345678');
  });
  it('odmietne 7-miestne IČO s akčnou hláškou', () => {
    expect(() => validateIco('1234567')).toThrowError(ToolError);
    expect(() => validateIco('1234567')).toThrowError(
      /IČO 1234567 má 7 číslic, očakávam 8\. Skús skfirma_search/,
    );
  });
  it('odmietne nečíselný vstup', () => {
    expect(() => validateIco('FIRMA')).toThrowError(/nie je IČO/);
  });
});
