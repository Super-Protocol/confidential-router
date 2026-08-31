import { Card, CardContent, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { KeyRound } from 'lucide-react';
import Link from 'next/link';
import { formatUsd } from '../../lib/format';
import { formatCount } from '../../lib/metrics';

export interface TopKeyUsage {
  apiKeyId: string | null;
  name: string;
  prefix: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  spendMicros: string;
}

export interface TopKeysCardProps {
  keys: TopKeyUsage[];
}

/**
 * API keys by spend for the selected range.
 *
 * The share bar is drawn against the *leader*, not against the workspace total:
 * five keys never sum to the whole, so a percentage-of-total bar would read as
 * a composition the list does not show.
 */
export function TopKeysCard({ keys }: TopKeysCardProps) {
  const leader = keys.reduce((acc, key) => Math.max(acc, Number(key.spendMicros)), 0);

  return (
    <Card>
      <CardHeader className="border-b pb-4">
        <CardTitle className="text-sm">Top API keys</CardTitle>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <EmptyState
            className="border-0 py-6"
            icon={<KeyRound className="size-5" aria-hidden="true" />}
            title="No keys were used in this period"
            description={<Link href="/keys">Issue a key</Link>}
          />
        ) : (
          <ol aria-label="Top API keys by spend" className="space-y-3.5">
            {keys.map((key, index) => {
              const spend = Number(key.spendMicros);

              return (
                <li key={key.apiKeyId ?? `${key.name}-${index}`} className="flex items-center gap-3">
                  <span className="w-4 shrink-0 text-center font-mono text-muted-foreground text-xs">{index + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate font-medium text-sm">{key.name}</span>
                      <span className="shrink-0 font-mono text-sm">{formatUsd(key.spendMicros)}</span>
                    </div>
                    <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-brand"
                        style={{ width: leader > 0 ? `${(spend / leader) * 100}%` : '0%' }}
                      />
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-3 text-muted-foreground text-xs">
                      <span className="truncate font-mono">{key.prefix ?? 'deleted key'}</span>
                      <span className="shrink-0">
                        {formatCount(key.promptTokens + key.completionTokens)} tok · {formatCount(key.requests)} req
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
