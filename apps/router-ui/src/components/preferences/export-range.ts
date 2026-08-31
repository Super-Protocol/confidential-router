/**
 * The auditor's export takes a period, and a date input gives a calendar day.
 * Turning one into the other is the only logic on the Preferences screen worth
 * testing on its own.
 */

/** How many days back the export range starts by default. */
export const DEFAULT_EXPORT_DAYS = 30;

export interface ExportRangeValues {
  /** `yyyy-mm-dd`, as `<input type="date">` gives it. */
  from: string;
  to: string;
}

export function defaultExportRange(now: Date = new Date()): ExportRangeValues {
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return {
    from: new Date(today - DEFAULT_EXPORT_DAYS * 86_400_000).toISOString().slice(0, 10),
    to: new Date(today).toISOString().slice(0, 10),
  };
}

export interface ExportRangeInstants {
  from: string;
  to: string;
}

/**
 * The two days as the instants the API takes: `from` opens at the start of its
 * day, `to` closes at the end of its own.
 *
 * `to` is exclusive on the API side, so "to the 5th" has to become the 6th at
 * midnight — closing it at the 5th would silently drop everything served that
 * day, which is the day an auditor asking for "up to the 5th" cares about most.
 */
export function exportRangeInstants(values: ExportRangeValues): ExportRangeInstants | { error: string } {
  const from = Date.parse(`${values.from}T00:00:00.000Z`);
  const to = Date.parse(`${values.to}T00:00:00.000Z`);

  if (Number.isNaN(from) || Number.isNaN(to)) return { error: 'Pick both a start and an end date.' };
  if (to < from) return { error: 'The end of the range must be on or after its start.' };

  return { from: new Date(from).toISOString(), to: new Date(to + 86_400_000).toISOString() };
}
