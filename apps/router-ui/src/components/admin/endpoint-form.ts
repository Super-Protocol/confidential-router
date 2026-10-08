import type { ExternalModelInput, RegisterExternalEndpointInput } from '../../generated/graphql';
import { usdToMicros } from '../../lib/format';

export interface ModelFormValues {
  /** The id this router will serve it under — the public catalogue slug. */
  id: string;
  name: string;
  /** What the upstream calls it, which is what the egress leg sends. */
  upstreamModel: string;
  contextLength: string;
  /** USD per 1M tokens, as typed. Converted to micros on submit. */
  promptPer1m: string;
  completionPer1m: string;
}

export interface EndpointFormValues {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: ModelFormValues[];
}

export const EMPTY_MODEL: ModelFormValues = {
  id: '',
  name: '',
  upstreamModel: '',
  contextLength: '',
  promptPer1m: '',
  completionPer1m: '',
};

export const EMPTY_ENDPOINT_FORM: EndpointFormValues = {
  name: '',
  baseUrl: '',
  apiKey: '',
  models: [{ ...EMPTY_MODEL }],
};

/**
 * The endpoint name is also the sidecar's endpoint key, so it obeys the
 * gatekeeper config's kebab-case `name` pattern rather than being free text —
 * a name this form accepts and the sidecar rejects would fail at reload, where
 * nobody is looking at a form.
 */
const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Flat, dotted paths so one map covers the endpoint fields and every model row. */
export type EndpointFormErrors = Record<string, string>;

/** `seen` carries the ids of earlier rows, so a duplicate is reported on the second one. */
function validateModel(model: ModelFormValues, index: number, seen: Set<string>): EndpointFormErrors {
  const errors: EndpointFormErrors = {};
  const at = (field: string) => `models.${index}.${field}`;

  const id = model.id.trim();
  if (id === '') errors[at('id')] = 'A model id is required.';
  else if (seen.has(id)) errors[at('id')] = 'This id is listed twice.';
  seen.add(id);

  if (model.name.trim() === '') errors[at('name')] = 'A display name is required.';
  if (model.upstreamModel.trim() === '') errors[at('upstreamModel')] = 'The upstream’s own model id is required.';

  const contextLength = Number(model.contextLength);
  if (!Number.isInteger(contextLength) || contextLength <= 0) {
    errors[at('contextLength')] = 'Context length must be a whole number of tokens.';
  }

  for (const field of ['promptPer1m', 'completionPer1m'] as const) {
    if (model[field].trim() === '') errors[at(field)] = 'A price is required.';
    else if (usdToMicros(model[field]) === null) errors[at(field)] = 'Enter a price in USD, for example 0.60.';
  }

  return errors;
}

/**
 * Everything checked in the browser, and nothing more. The server re-validates;
 * this exists so the common mistakes are caught next to the field that made
 * them, which a GraphQL `BAD_USER_INPUT` cannot do.
 */
export function validateEndpointForm(values: EndpointFormValues, { requireKey = true } = {}): EndpointFormErrors {
  const errors: EndpointFormErrors = {};

  const name = values.name.trim();
  if (name === '') errors.name = 'A name is required.';
  else if (name.length > 64) errors.name = 'Keep the name to 64 characters.';
  else if (!NAME_PATTERN.test(name))
    errors.name = 'Use lower-case letters, digits and hyphens, for example qwen3-coder.';

  const baseUrl = values.baseUrl.trim();
  if (baseUrl === '') {
    errors.baseUrl = 'A base URL is required.';
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(baseUrl);
    } catch {
      parsed = null;
    }
    if (!parsed) errors.baseUrl = 'Enter a full URL, for example https://host.example.';
    else if (parsed.protocol !== 'https:')
      errors.baseUrl = 'The base URL must be https — the egress pins a certificate.';
  }

  if (requireKey && values.apiKey.trim() === '') errors.apiKey = 'The upstream’s API key is required.';

  Object.assign(errors, validateModels(values.models));

  return errors;
}

/**
 * The model rows alone, keyed `models.<index>.<field>` — shared by the typed
 * form and the discovery picker, which register the same `ExternalModelInput`.
 */
export function validateModels(models: readonly ModelFormValues[]): EndpointFormErrors {
  if (models.length === 0) return { models: 'Register at least one model.' };
  const errors: EndpointFormErrors = {};
  const seen = new Set<string>();
  for (const [index, model] of models.entries()) {
    Object.assign(errors, validateModel(model, index, seen));
  }
  return errors;
}

export function toModelInput(model: ModelFormValues): ExternalModelInput {
  return {
    id: model.id.trim(),
    name: model.name.trim(),
    upstreamModel: model.upstreamModel.trim(),
    contextLength: Number(model.contextLength),
    // `usdToMicros` has already been validated; the fallback keeps the types
    // honest rather than papering over a bug.
    promptPer1mMicros: usdToMicros(model.promptPer1m) ?? '0',
    completionPer1mMicros: usdToMicros(model.completionPer1m) ?? '0',
  };
}

export function toRegisterInput(values: EndpointFormValues): RegisterExternalEndpointInput {
  return {
    name: values.name.trim(),
    baseUrl: values.baseUrl.trim(),
    apiKey: values.apiKey,
    models: values.models.map(toModelInput),
  };
}
