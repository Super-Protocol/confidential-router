'use client';

import { cn } from '@confidential-router/ui/lib/utils';
import { RANGE_KEYS, RANGE_OPTIONS, type RangeKey } from '../../lib/ranges';

export interface RangePickerProps {
  value: RangeKey;
  onChange: (value: RangeKey) => void;
  /** Names the group for a screen reader. */
  label?: string;
  disabled?: boolean;
}

/**
 * The 24h / 7d / 30d toggle that drives every query on Activity and Logs.
 *
 * Buttons with `aria-pressed` rather than a `radiogroup`: each option is an
 * action the viewer takes immediately, not a value they set and then submit,
 * and a toggle button says that without needing roving tab order to be right.
 * The long form ("Past 7 days") is the accessible name, so the control is not
 * three unlabelled abbreviations to a screen reader.
 */
export function RangePicker({ value, onChange, label = 'Time range', disabled = false }: RangePickerProps) {
  return (
    // A `fieldset` rather than a `div role="group"`: it is the element the role
    // exists for, and `aria-label` names it without a visible `legend`.
    <fieldset
      aria-label={label}
      className="inline-flex min-w-0 items-center gap-[3px] rounded-lg bg-muted p-[3px]"
      data-slot="range-picker"
    >
      {RANGE_KEYS.map((key) => {
        const option = RANGE_OPTIONS[key];
        const active = key === value;

        return (
          <button
            key={key}
            type="button"
            aria-pressed={active}
            aria-label={option.long}
            disabled={disabled}
            onClick={() => onChange(key)}
            className={cn(
              'rounded-md px-2.5 py-1 font-medium text-sm transition-[color,background-color,box-shadow] focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-50',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground dark:hover:bg-input/30',
            )}
          >
            {option.short}
          </button>
        );
      })}
    </fieldset>
  );
}
