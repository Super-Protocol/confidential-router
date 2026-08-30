import { InitialSchema1756600000000 } from './1756600000000-InitialSchema.js';

/**
 * Migrations are imported rather than globbed: the production build is a single
 * webpack bundle, and a glob would resolve to nothing inside it.
 *
 * Order is the array order, so new migrations are appended, never inserted.
 */
export const MIGRATIONS = [InitialSchema1756600000000];
