/**
 * Ported verbatim from Super-Protocol/swarm-cloud `libs/ui/src/lib/utils.ts` (BSL-1.1)
 * with permission; see the repository NOTICE. Upstream: shadcn/ui (MIT).
 */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
