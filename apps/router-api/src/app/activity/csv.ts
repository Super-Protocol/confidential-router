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
