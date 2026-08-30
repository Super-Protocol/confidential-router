/**
 * Deep merge of plain configuration objects.
 *
 * Later sources win. Plain objects are merged recursively; every other value —
 * arrays included — is replaced wholesale. That last part is the reason this
 * exists instead of `lodash.merge`, which merges arrays element-by-element and
 * would leave, say, `validClientOrigins: [a, b]` from the YAML partially
 * shining through an env override of `[c]`.
 */
export function deepMerge<T>(...sources: Array<Partial<T> | undefined | null>): T {
  return sources.reduce<Record<string, unknown>>((acc, source) => {
    if (!isPlainObject(source)) {
      return acc;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) {
        continue;
      }
      acc[key] = isPlainObject(value) && isPlainObject(acc[key]) ? deepMerge(acc[key], value) : value;
    }
    return acc;
  }, {}) as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
