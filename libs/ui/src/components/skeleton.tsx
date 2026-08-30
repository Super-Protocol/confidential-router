/**
 * Ported verbatim from Super-Protocol/swarm-cloud `libs/ui/src/components/skeleton.tsx` (BSL-1.1)
 * with permission; see the repository NOTICE. Upstream: shadcn/ui (MIT).
 */
import { cn } from '../lib/utils';

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="skeleton" className={cn('bg-accent animate-pulse rounded-md', className)} {...props} />;
}

export { Skeleton };
