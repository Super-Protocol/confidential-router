'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { CircleHelp, ShieldCheck, ShieldX, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import type { ImageVerdict } from './graph-model';

/**
 * How each image verdict reads and is coloured, in one table.
 *
 * Same rule as `verification/tiers.ts`, applied to the one other claim this
 * feature makes: a stronger word may only appear when a stronger thing actually
 * happened. `declared` is the only green, and the two not-a-verdict states —
 * nothing declared, nothing pinned — are deliberately neither green nor red.
 */
export const IMAGE_VERDICTS: Record<
  ImageVerdict['status'],
  { label: string; variant: 'success' | 'warning' | 'secondary' | 'destructive'; sentence: string }
> = {
  declared: {
    label: 'Declared',
    variant: 'success',
    sentence: 'This digest is one the operator declares this endpoint runs.',
  },
  'digest-mismatch': {
    label: 'Undeclared build',
    variant: 'destructive',
    sentence:
      'The operator declares this image, but at a different digest. The signed evidence says the endpoint is ' +
      'running a build the declaration does not cover.',
  },
  'not-declared': {
    label: 'Undeclared',
    variant: 'destructive',
    sentence:
      'The signed evidence carries this image and the operator’s declaration does not mention it at all. Treat ' +
      'it as unexplained until the operator accounts for it.',
  },
  'not-pinned': {
    label: 'Not digest-pinned',
    variant: 'warning',
    sentence:
      'The evidence names this image by tag rather than by digest. A tag is mutable, so there is nothing here to ' +
      'match against a pin — this is neither a pass nor a failure.',
  },
  'no-allow-list': {
    label: 'Nothing declared',
    variant: 'secondary',
    sentence:
      'This endpoint declares no image allow-list, so nothing was compared. The digest below is what the ' +
      'evidence signs; what it is supposed to be has not been stated.',
  },
};

const ICONS: Record<ImageVerdict['status'], React.ComponentType<{ className?: string }>> = {
  declared: ShieldCheck,
  'digest-mismatch': ShieldX,
  'not-declared': ShieldX,
  'not-pinned': TriangleAlert,
  'no-allow-list': CircleHelp,
};

const TONES: Record<ImageVerdict['status'], string> = {
  declared: 'text-success',
  'digest-mismatch': 'text-destructive',
  'not-declared': 'text-destructive',
  'not-pinned': 'text-warning',
  'no-allow-list': 'text-muted-foreground',
};

/** True for the two verdicts that mean "something is running that nobody declared". */
export function isUndeclared(verdict: ImageVerdict | null | undefined): boolean {
  return verdict?.status === 'not-declared' || verdict?.status === 'digest-mismatch';
}

export function ImageVerdictBadge({ verdict }: { verdict: ImageVerdict }) {
  const presentation = IMAGE_VERDICTS[verdict.status];
  return <Badge variant={presentation.variant}>{presentation.label}</Badge>;
}

export function ImageVerdictIcon({ verdict, className }: { verdict: ImageVerdict; className?: string }) {
  const Icon = ICONS[verdict.status];
  const presentation = IMAGE_VERDICTS[verdict.status];
  return <Icon className={`${TONES[verdict.status]} ${className ?? ''}`} aria-label={presentation.label} />;
}
