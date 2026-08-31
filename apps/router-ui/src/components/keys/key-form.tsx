'use client';

import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import * as React from 'react';
import type { CreateApiKeyInput, UpdateApiKeyInput } from '../../generated/graphql';
import { microsToUsdInput, usdToMicros } from '../../lib/format';
import type { ApiKeyRow, CatalogueModel } from './types';

export interface KeyFormValues {
  name: string;
  /** Null is the API's "every model in the catalogue". */
  modelIds: string[] | null;
  /** Dollars, as typed. Empty means no ceiling. */
  spendLimit: string;
  /** `yyyy-mm-dd`, as `<input type="date">` gives it. Empty means never. */
  expiresAt: string;
  requestsPerMinute: string;
  tokensPerMinute: string;
}

export type KeyFormErrors = Partial<Record<keyof KeyFormValues, string>>;

export const EMPTY_KEY_FORM: KeyFormValues = {
  name: '',
  modelIds: null,
  spendLimit: '',
  expiresAt: '',
  requestsPerMinute: '',
  tokensPerMinute: '',
};

export function keyFormOf(apiKey: ApiKeyRow): KeyFormValues {
  return {
    name: apiKey.name,
    modelIds: apiKey.modelScope ? [...apiKey.modelScope] : null,
    spendLimit: apiKey.spendLimitMicros ? microsToUsdInput(apiKey.spendLimitMicros) : '',
    expiresAt: apiKey.expiresAt ? apiKey.expiresAt.slice(0, 10) : '',
    requestsPerMinute: apiKey.requestsPerMinute?.toString() ?? '',
    tokensPerMinute: apiKey.tokensPerMinute?.toString() ?? '',
  };
}

function rateOf(value: string): number | null | 'invalid' {
  if (value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim())) return 'invalid';
  const parsed = Number(value);
  return parsed > 0 ? parsed : 'invalid';
}

export function validateKeyForm(values: KeyFormValues): KeyFormErrors {
  const errors: KeyFormErrors = {};

  if (values.name.trim() === '') errors.name = 'Give the key a name you will recognise in the log.';
  if (values.modelIds !== null && values.modelIds.length === 0) {
    errors.modelIds = 'Pick at least one model, or let the key call every model.';
  }
  if (values.spendLimit.trim() !== '' && usdToMicros(values.spendLimit) === null) {
    errors.spendLimit = 'Enter an amount in dollars, e.g. 25 or 12.50.';
  }
  if (rateOf(values.requestsPerMinute) === 'invalid') errors.requestsPerMinute = 'Enter a whole number above zero.';
  if (rateOf(values.tokensPerMinute) === 'invalid') errors.tokensPerMinute = 'Enter a whole number above zero.';

  return errors;
}

/**
 * A date input yields a calendar day; the API takes an instant. A key set to
 * expire "on the 5th" is expected to work all of the 5th, so the day is closed
 * at its last UTC millisecond rather than opened at its first.
 */
export function expiryInstant(day: string): string | null {
  if (day.trim() === '') return null;
  const date = new Date(`${day}T23:59:59.999Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The fields shared by create and update; the two inputs differ only in the scope spelling. */
function commonInput(values: KeyFormValues) {
  return {
    name: values.name.trim(),
    spendLimitMicros: values.spendLimit.trim() === '' ? null : usdToMicros(values.spendLimit),
    expiresAt: expiryInstant(values.expiresAt),
    requestsPerMinute: rateValue(values.requestsPerMinute),
    tokensPerMinute: rateValue(values.tokensPerMinute),
  };
}

function rateValue(value: string): number | null {
  const parsed = rateOf(value);
  return parsed === 'invalid' ? null : parsed;
}

export function toCreateInput(values: KeyFormValues, workspaceId: string): CreateApiKeyInput {
  return { workspaceId, ...commonInput(values), modelIds: values.modelIds ?? null };
}

/**
 * Every field is sent, including the nulls: `UpdateApiKeyInput` replaces what it
 * is given, so omitting a cleared limit would leave the old one in place. An
 * empty `modelIds` list is how the API spells "this key may call anything".
 */
export function toUpdateInput(values: KeyFormValues): UpdateApiKeyInput {
  return { ...commonInput(values), modelIds: values.modelIds ?? [] };
}

export interface KeyFormFieldsProps {
  values: KeyFormValues;
  onChange: (values: KeyFormValues) => void;
  errors: KeyFormErrors;
  models: readonly CatalogueModel[];
  /** Prefix for every field id, so two forms can be mounted at once. */
  idPrefix: string;
  disabled?: boolean;
}

export function KeyFormFields({ values, onChange, errors, models, idPrefix, disabled }: KeyFormFieldsProps) {
  const scoped = values.modelIds !== null;
  const set = (patch: Partial<KeyFormValues>) => onChange({ ...values, ...patch });

  const toggleModel = (id: string, checked: boolean) => {
    const current = values.modelIds ?? [];
    set({ modelIds: checked ? [...current, id] : current.filter((modelId) => modelId !== id) });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input
          id={`${idPrefix}-name`}
          value={values.name}
          onChange={(event) => set({ name: event.target.value })}
          placeholder="production-agent"
          disabled={disabled}
          aria-invalid={errors.name !== undefined || undefined}
          aria-describedby={errors.name ? `${idPrefix}-name-error` : undefined}
        />
        <FieldError id={`${idPrefix}-name-error`} message={errors.name} />
      </div>

      <fieldset className="flex flex-col gap-2" disabled={disabled}>
        <legend className="mb-2 font-medium text-sm">Model scope</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-primary"
            checked={scoped}
            onChange={(event) => set({ modelIds: event.target.checked ? [] : null })}
          />
          <span>
            Restrict this key to specific models
            <span className="block text-muted-foreground text-xs">
              Unrestricted keys may call every model in the catalogue.
            </span>
          </span>
        </label>
        {scoped ? (
          <div className="max-h-40 overflow-y-auto rounded-md border p-2">
            {models.length === 0 ? (
              <p className="p-1 text-muted-foreground text-xs">The catalogue is empty.</p>
            ) : (
              models.map((model) => (
                <label key={model.id} className="flex items-center gap-2 p-1 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={values.modelIds?.includes(model.id) ?? false}
                    onChange={(event) => toggleModel(model.id, event.target.checked)}
                  />
                  <span className="truncate">{model.name}</span>
                </label>
              ))
            )}
          </div>
        ) : null}
        <FieldError id={`${idPrefix}-scope-error`} message={errors.modelIds} />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-spend`}>Spend limit (USD)</Label>
          <Input
            id={`${idPrefix}-spend`}
            inputMode="decimal"
            value={values.spendLimit}
            onChange={(event) => set({ spendLimit: event.target.value })}
            placeholder="No limit"
            disabled={disabled}
            aria-invalid={errors.spendLimit !== undefined || undefined}
            aria-describedby={errors.spendLimit ? `${idPrefix}-spend-error` : undefined}
          />
          <FieldError id={`${idPrefix}-spend-error`} message={errors.spendLimit} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-expires`}>Expires</Label>
          <Input
            id={`${idPrefix}-expires`}
            type="date"
            value={values.expiresAt}
            onChange={(event) => set({ expiresAt: event.target.value })}
            disabled={disabled}
          />
          <p className="text-muted-foreground text-xs">Leave empty for a key that never expires.</p>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-rpm`}>Requests per minute</Label>
          <Input
            id={`${idPrefix}-rpm`}
            inputMode="numeric"
            value={values.requestsPerMinute}
            onChange={(event) => set({ requestsPerMinute: event.target.value })}
            placeholder="Workspace default"
            disabled={disabled}
            aria-invalid={errors.requestsPerMinute !== undefined || undefined}
            aria-describedby={errors.requestsPerMinute ? `${idPrefix}-rpm-error` : undefined}
          />
          <FieldError id={`${idPrefix}-rpm-error`} message={errors.requestsPerMinute} />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-tpm`}>Tokens per minute</Label>
          <Input
            id={`${idPrefix}-tpm`}
            inputMode="numeric"
            value={values.tokensPerMinute}
            onChange={(event) => set({ tokensPerMinute: event.target.value })}
            placeholder="Workspace default"
            disabled={disabled}
            aria-invalid={errors.tokensPerMinute !== undefined || undefined}
            aria-describedby={errors.tokensPerMinute ? `${idPrefix}-tpm-error` : undefined}
          />
          <FieldError id={`${idPrefix}-tpm-error`} message={errors.tokensPerMinute} />
        </div>
      </div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="text-destructive text-xs">
      {message}
    </p>
  );
}

/** Form state plus the validation the two dialogs share. */
export function useKeyForm(initial: KeyFormValues) {
  const [values, setValues] = React.useState(initial);
  const [errors, setErrors] = React.useState<KeyFormErrors>({});

  const validate = () => {
    const found = validateKeyForm(values);
    setErrors(found);
    return Object.keys(found).length === 0;
  };

  return { values, setValues, errors, validate, reset: () => setValues(initial) };
}
