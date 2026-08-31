'use client';

import { Badge } from '@confidential-router/ui/components/badge';
import { Button } from '@confidential-router/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@confidential-router/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@confidential-router/ui/components/table';
import { MoreHorizontal } from 'lucide-react';
import { formatDate, formatUsd, microsToUsd } from '../../lib/format';
import type { ApiKeyRow, CatalogueModel } from './types';

export interface ApiKeyTableProps {
  keys: readonly ApiKeyRow[];
  models: readonly CatalogueModel[];
  onEdit: (apiKey: ApiKeyRow) => void;
  onRevoke: (apiKey: ApiKeyRow) => void;
}

/** `null` scope is "every model in the catalogue" — not "no models". */
export function scopeLabel(apiKey: ApiKeyRow, models: readonly CatalogueModel[]): string {
  if (!apiKey.modelScope) return 'All models';
  if (apiKey.modelScope.length === 0) return 'No models';
  const nameOf = new Map(models.map((model) => [model.id, model.name]));
  return apiKey.modelScope.map((id) => nameOf.get(id) ?? id).join(', ');
}

/** How much of the key's ceiling is spent, 0–100. Unlimited keys have no bar. */
export function spendPercent(apiKey: ApiKeyRow): number | null {
  if (!apiKey.spendLimitMicros) return null;
  const limit = microsToUsd(apiKey.spendLimitMicros);
  if (limit <= 0) return null;
  return Math.min(100, Math.round((microsToUsd(apiKey.spentTotalMicros) / limit) * 100));
}

function expiryCell(apiKey: ApiKeyRow) {
  if (!apiKey.expiresAt) return <span className="text-muted-foreground">Never</span>;
  const expired = new Date(apiKey.expiresAt).getTime() < Date.now();
  return expired ? <Badge variant="warning">Expired</Badge> : <span>{formatDate(apiKey.expiresAt)}</span>;
}

export function ApiKeyTable({ keys, models, onEdit, onRevoke }: ApiKeyTableProps) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Model scope</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="text-right">Usage</TableHead>
            <TableHead>Limit</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.map((apiKey) => {
            const percent = spendPercent(apiKey);
            const revoked = apiKey.revokedAt !== null;

            return (
              <TableRow key={apiKey.id} data-revoked={revoked || undefined}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{apiKey.name}</span>
                    {revoked ? <Badge variant="destructive">Revoked</Badge> : null}
                  </div>
                  <div className="font-mono text-muted-foreground text-xs">{apiKey.prefix}…</div>
                </TableCell>
                <TableCell className="max-w-56">
                  <span className="block truncate" title={scopeLabel(apiKey, models)}>
                    {scopeLabel(apiKey, models)}
                  </span>
                </TableCell>
                <TableCell>{expiryCell(apiKey)}</TableCell>
                <TableCell>
                  {apiKey.lastUsedAt ? (
                    formatDate(apiKey.lastUsedAt)
                  ) : (
                    <span className="text-muted-foreground">Never</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono">{formatUsd(apiKey.spentTotalMicros)}</TableCell>
                <TableCell>
                  {apiKey.spendLimitMicros ? (
                    <div className="space-y-1">
                      <span className="text-muted-foreground text-xs">{formatUsd(apiKey.spendLimitMicros)}</span>
                      <div
                        className="h-1 w-24 overflow-hidden rounded-full bg-muted"
                        role="progressbar"
                        aria-label={`${apiKey.name} spend against its limit`}
                        aria-valuenow={percent ?? 0}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div className="h-full bg-brand" style={{ width: `${percent ?? 0}%` }} />
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted-foreground text-xs">No limit</span>
                  )}
                </TableCell>
                <TableCell>
                  {revoked ? null : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${apiKey.name}`}>
                          <MoreHorizontal className="size-4" aria-hidden="true" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => onEdit(apiKey)}>Edit limits and scope</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => onRevoke(apiKey)}>
                          Revoke
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="border-t px-4 py-2.5 text-muted-foreground text-xs">
        {keys.length} {keys.length === 1 ? 'key' : 'keys'}
      </p>
    </div>
  );
}
