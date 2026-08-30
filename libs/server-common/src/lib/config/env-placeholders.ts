const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export class MissingEnvPlaceholderError extends Error {
  readonly variables: string[];

  constructor(variables: string[]) {
    super(
      `Configuration references environment variables that are not set: ${variables.join(', ')}. ` +
        'Set them, or give the placeholder a default with ${VAR:-fallback}.',
    );
    this.name = 'MissingEnvPlaceholderError';
    this.variables = variables;
  }
}

/**
 * Expands `${VAR}` / `${VAR:-default}` placeholders in every string of a parsed
 * config tree. Committed YAML therefore never has to carry a secret: it names
 * the variable, the deployment supplies the value.
 *
 * A placeholder with no value and no default is a deployment mistake that would
 * otherwise surface as an unrelated validation error deep in the schema, so it
 * throws here, naming every offender at once.
 */
export function expandEnvPlaceholders<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  const missing = new Set<string>();
  const expanded = walk(value, env, missing);
  if (missing.size > 0) {
    throw new MissingEnvPlaceholderError([...missing].sort());
  }
  return expanded as T;
}

function walk(value: unknown, env: NodeJS.ProcessEnv, missing: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (match, name: string, fallback?: string) => {
      const resolved = env[name];
      if (resolved !== undefined && resolved !== '') {
        return resolved;
      }
      if (fallback !== undefined) {
        return fallback;
      }
      missing.add(name);
      return match;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, env, missing));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, env, missing)]));
  }
  return value;
}
