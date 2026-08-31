import type { ApiKeyFieldsFragment, ApiKeysQuery } from '../../generated/graphql';

/** One row of the key table. */
export type ApiKeyRow = ApiKeyFieldsFragment;

/** Only what the scope column and the scope picker need from the catalogue. */
export type CatalogueModel = ApiKeysQuery['models'][number];
