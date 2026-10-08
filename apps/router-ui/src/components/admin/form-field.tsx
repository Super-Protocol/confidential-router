import { Input } from '@confidential-router/ui/components/input';
import { Label } from '@confidential-router/ui/components/label';
import type * as React from 'react';
import type { EndpointFormErrors, ModelFormValues } from './endpoint-form';

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-destructive text-xs">
      {message}
    </p>
  );
}

export interface FormFieldProps {
  id: string;
  label: React.ReactNode;
  help?: React.ReactNode;
  error?: string;
  children: React.ReactNode;
}

/**
 * Label, control, help and error, with the gap between them owned here.
 *
 * The admin dialogs used to stack a bare `Label` on an `Input` and let each
 * field pick its own margins, which is how the register form ended up with
 * labels sitting on their inputs (SUP-249). One wrapper, one rhythm.
 */
export function FormField({ id, label, help, error, children }: FormFieldProps) {
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {help && !error ? (
        <p id={`${id}-help`} className="text-muted-foreground text-xs">
          {help}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} message={error} />
    </div>
  );
}

/** `aria-describedby` for a control inside {@link FormField}: the error while there is one, the help otherwise. */
export function describedBy(id: string, { error, help }: { error?: string; help?: boolean }): string | undefined {
  if (error) return `${id}-error`;
  return help ? `${id}-help` : undefined;
}

export interface ModelFieldsProps {
  index: number;
  model: ModelFormValues;
  errors: EndpointFormErrors;
  disabled: boolean;
  onChange: (patch: Partial<ModelFormValues>) => void;
  /** False when the upstream id is not the admin's to type — the discovery picker already knows it. */
  editableUpstream?: boolean;
}

const MODEL_FIELDS = [
  { field: 'id', suffix: 'id', label: 'Model id on this router', inputMode: undefined },
  { field: 'upstreamModel', suffix: 'upstream', label: 'Model id upstream', inputMode: undefined },
  { field: 'name', suffix: 'name', label: 'Display name', inputMode: undefined },
  { field: 'contextLength', suffix: 'context', label: 'Context length', inputMode: 'numeric' },
  { field: 'promptPer1m', suffix: 'prompt-price', label: 'Prompt, USD / 1M', inputMode: 'decimal' },
  { field: 'completionPer1m', suffix: 'completion-price', label: 'Completion, USD / 1M', inputMode: 'decimal' },
] as const;

/** Without the upstream id the picker already shows: the two prices side by side, context last. */
const PICKER_FIELDS = ['id', 'name', 'promptPer1m', 'completionPer1m', 'contextLength'].map(
  (field) => MODEL_FIELDS.find((entry) => entry.field === field) as (typeof MODEL_FIELDS)[number],
);

/** One model's six inputs, as a two-column grid. */
export function ModelFields({ index, model, errors, disabled, onChange, editableUpstream = true }: ModelFieldsProps) {
  return (
    <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
      {(editableUpstream ? MODEL_FIELDS : PICKER_FIELDS).map(({ field, suffix, label, inputMode }) => {
        const id = `model-${index}-${suffix}`;
        const error = errors[`models.${index}.${field}`];
        return (
          <FormField key={field} id={id} label={label} error={error}>
            <Input
              id={id}
              inputMode={inputMode}
              value={model[field]}
              onChange={(event) => onChange({ [field]: event.target.value })}
              aria-describedby={describedBy(id, { error })}
              aria-invalid={Boolean(error)}
              disabled={disabled}
              autoComplete="off"
            />
          </FormField>
        );
      })}
    </div>
  );
}
