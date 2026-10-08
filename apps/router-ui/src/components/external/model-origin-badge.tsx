import { Badge } from '@confidential-router/ui/components/badge';
import type { ModelOrigin } from '../../generated/graphql';
import { MODEL_ORIGIN_PRESENTATION } from './external-vocabulary';

export interface ModelOriginBadgeProps {
  origin: ModelOrigin;
}

/**
 * "External", or nothing.
 *
 * Nothing for a config model: see {@link MODEL_ORIGIN_PRESENTATION}. The badge
 * carries no verdict and no state — it says *where the model runs*, which is the
 * one thing about an external row that is true whatever this router currently
 * thinks of its upstream. The attestation state is a separate badge in a separate
 * column, from a separate vocabulary.
 */
export function ModelOriginBadge({ origin }: ModelOriginBadgeProps) {
  const presentation = MODEL_ORIGIN_PRESENTATION[origin];
  if (!presentation) {
    return null;
  }
  return (
    <Badge variant="brand" title={presentation.description}>
      {presentation.label}
    </Badge>
  );
}
