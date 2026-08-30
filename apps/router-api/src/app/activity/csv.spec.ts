import { describe, expect, it } from 'vitest';
import { csvField, csvRow } from './csv.js';

describe('csvField', () => {
  it('leaves a plain value alone', () => {
    expect(csvField('gen-1')).toBe('gen-1');
    expect(csvField(42)).toBe('42');
    expect(csvField(null)).toBe('');
  });

  it('quotes and escapes anything that would break the row', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak')).toBe('"line\nbreak"');
  });

  it('neutralises a value a spreadsheet would run as a formula', () => {
    // A key name is chosen by the user and lands in the export unchanged.
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)");
  });
});

describe('csvRow', () => {
  it('joins with commas and ends with CRLF', () => {
    expect(csvRow(['a', 1, null])).toBe('a,1,\r\n');
  });
});
