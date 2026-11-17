/**
 * Minimal RFC 4180 CSV writer.
 *
 * A dependency-free one because the only thing this has to get right is
 * quoting, and the export is a flat table of numbers and identifiers — there is
 * no schema, no streaming protocol and no dialect to negotiate.
 */

export function csvRow(values: ReadonlyArray<string | number | null | undefined>): string {
  return `${values.map(csvField).join(',')}\r\n`;
}

export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const text = String(value);
  // A leading =, +, - or @ makes a spreadsheet treat the cell as a formula. The
  // export carries model ids and key names, which a user chose, so neutralise it.
  //
  // This also quotes a leading minus, so it would mangle a negative number. The
  // export has none — tokens, latency and cost are all non-negative, and the
  // ledger, which does carry signed amounts, is not exported here. Exclude the
  // numeric columns before that stops being true.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/** The file is not CSV a reader can make rows of. `line` is 1-based. */
export class CsvSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message);
    this.name = 'CsvSyntaxError';
  }
}

/**
 * The reader for what {@link csvRow} writes: RFC 4180 records, quoted fields
 * with doubled quotes, CRLF or bare LF line ends, an optional UTF-8 byte-order
 * mark (a spreadsheet's "Save as CSV" adds one).
 *
 * Returns raw field text. It does not undo {@link csvField}'s formula guard —
 * see {@link unguardCsvField} — and it skips lines that are wholly empty, which
 * is what a trailing newline or a spreadsheet's padding produces.
 */
export function parseCsv(text: string): string[][] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;

  const endField = (): void => {
    record.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRecord = (): void => {
    endField();
    if (record.length > 1 || record[0] !== '') {
      records.push(record);
    }
    record = [];
  };

  for (let at = 0; at < source.length; at += 1) {
    const character = source[at];
    if (quoted) {
      if (character === '"') {
        if (source[at + 1] === '"') {
          field += '"';
          at += 1;
        } else {
          quoted = false;
        }
      } else {
        if (character === '\n') {
          line += 1;
        }
        field += character;
      }
    } else if (character === '"') {
      if (field !== '' || wasQuoted) {
        throw new CsvSyntaxError(`Line ${line}: a quote in the middle of an unquoted field.`, line);
      }
      quoted = true;
      wasQuoted = true;
    } else if (character === ',') {
      endField();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[at + 1] === '\n') {
        at += 1;
      }
      endRecord();
      line += 1;
    } else {
      if (wasQuoted) {
        throw new CsvSyntaxError(`Line ${line}: text after a closing quote.`, line);
      }
      field += character;
    }
  }
  if (quoted) {
    throw new CsvSyntaxError(`Line ${line}: a quoted field is never closed.`, line);
  }
  if (field !== '' || record.length > 0) {
    endRecord();
  }
  return records;
}

/**
 * Takes {@link csvField}'s formula guard back off, so a value that went out as
 * `'=SUM(…)` comes back as it was stored.
 *
 * The one value this cannot round-trip is text that itself began with an
 * apostrophe followed by `=`, `+`, `-` or `@`: it is written unguarded and read
 * back one character short. Nothing the invitations export carries has that
 * shape outside a free-text note.
 */
export function unguardCsvField(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}
