'use client';

import { useMutation, useQuery } from '@apollo/client/react';
import { Card, CardDescription, CardHeader, CardTitle } from '@confidential-router/ui/components/card';
import { ErrorState } from '@confidential-router/ui/components/error-state';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@confidential-router/ui/components/select';
import { Skeleton } from '@confidential-router/ui/components/skeleton';
import { Switch } from '@confidential-router/ui/components/switch';
import { toast } from 'sonner';
import type { UpdatePreferencesInput } from '../../generated/graphql';
import { formatDate } from '../../lib/format';
import { errorMessageOf } from '../../lib/graphql-error';
import { PageHeader } from '../page-header';
import { useSession } from '../session/session-provider';
import { ExportEvidenceCard } from './export-evidence-card';
import { PREFERENCES_QUERY, UPDATE_PREFERENCES } from './operations';
import { SettingRow } from './setting-row';

/** The retention windows the screen offers. The API accepts 1–3650 days. */
const RETENTION_OPTIONS = [30, 90, 180, 365, 730] as const;

/**
 * Account settings and the Evidence group.
 *
 * Every control writes on change rather than behind a Save button: each is one
 * independent boolean or number, and `updatePreferences` updates only the
 * settings it is given, so there is no half-saved state a form could protect
 * against.
 */
export function PreferencesScreen() {
  const { activeWorkspace } = useSession();
  const { data, error, refetch } = useQuery(PREFERENCES_QUERY, { fetchPolicy: 'cache-and-network' });
  const [updatePreferences, { loading: saving }] = useMutation(UPDATE_PREFERENCES);

  const preferences = data?.me.preferences ?? null;

  const save = async (input: UpdatePreferencesInput, description: string) => {
    try {
      await updatePreferences({
        variables: { input },
        // `UserPreferences` carries no id, so Apollo cannot link the mutation's
        // result to the viewer it belongs to; without this the toggle would
        // snap back to the cached value the moment the screen re-rendered.
        update: (cache, { data }) => {
          const updated = data?.updatePreferences;
          if (!updated) return;
          cache.updateQuery({ query: PREFERENCES_QUERY }, (existing) =>
            existing ? { ...existing, me: { ...existing.me, preferences: updated } } : existing,
          );
        },
      });
      toast.success(description);
    } catch (cause) {
      toast.error(errorMessageOf(cause, 'The setting could not be saved.'));
    }
  };

  const header = (
    <PageHeader
      title="Preferences"
      description="How this account is notified, and what it keeps of the evidence the endpoints publish."
    />
  );

  if (error) {
    return (
      <>
        {header}
        <ErrorState
          title="Your preferences could not be loaded"
          description="The console could not read this account's settings."
          detail="Preferences"
          onRetry={() => void refetch()}
        />
      </>
    );
  }

  // `loading` is not part of the condition: the query is `cache-and-network`, so
  // it goes loading again on every refetch and the settings would flicker away.
  if (preferences === null) {
    return (
      <>
        {header}
        <div className="space-y-4" data-testid="preferences-loading">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    );
  }

  return (
    <>
      {header}

      <div className="space-y-6">
        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-6">
            <CardTitle>Account</CardTitle>
            <CardDescription>The identity you signed in with, and how this console reaches you.</CardDescription>
          </CardHeader>

          <SettingRow
            title="Signed in as"
            description={`Member since ${formatDate(data?.me.createdAt)}. Sign-in identity is managed by your provider, not here.`}
            control={<span className="font-mono text-sm">{data?.me.email}</span>}
          />
          <SettingRow
            title="Workspace"
            description="Every credit, key and generation on the other screens belongs to this workspace."
            control={
              <span className="text-sm">
                {activeWorkspace?.name ?? '—'}
                {activeWorkspace ? (
                  <span className="text-muted-foreground"> · {activeWorkspace.role.toLowerCase()}</span>
                ) : null}
              </span>
            }
          />
          <SettingRow
            htmlFor="pref-email-receipts"
            title="Email receipts"
            description="Send a receipt to your address for every purchase and automatic top-up."
            control={
              <Switch
                id="pref-email-receipts"
                checked={preferences.emailReceipts}
                disabled={saving}
                onCheckedChange={(checked) =>
                  void save({ emailReceipts: checked }, checked ? 'Email receipts on.' : 'Email receipts off.')
                }
              />
            }
          />
          <SettingRow
            htmlFor="pref-desktop-notifications"
            title="Desktop notifications"
            description="Alert this browser when an endpoint publishes a new bundle or its measurements change."
            control={
              <Switch
                id="pref-desktop-notifications"
                checked={preferences.desktopNotifications}
                disabled={saving}
                onCheckedChange={(checked) =>
                  void save(
                    { desktopNotifications: checked },
                    checked ? 'Desktop notifications on.' : 'Desktop notifications off.',
                  )
                }
              />
            }
          />
        </Card>

        <Card className="gap-0 py-0">
          <CardHeader className="border-b py-6">
            <CardTitle>Evidence</CardTitle>
            <CardDescription>
              What this account keeps of the bundles the endpoints publish. The verification policy itself lives in your
              Gatekeeper config, not here — this router never verifies anything.
            </CardDescription>
          </CardHeader>

          <SettingRow
            htmlFor="pref-archive-evidence"
            title="Archive quotes"
            description="Keep the published bundle and its JWS, not just the digest, so a response can be re-checked offline later."
            control={
              <Switch
                id="pref-archive-evidence"
                checked={preferences.archiveEvidence}
                disabled={saving}
                onCheckedChange={(checked) =>
                  void save({ archiveEvidence: checked }, checked ? 'Archiving quotes.' : 'No longer archiving quotes.')
                }
              />
            }
          />
          <SettingRow
            htmlFor="pref-retention"
            title="Retention window"
            description="How long archived bundles stay downloadable. Digests are kept for as long as the generation is."
            control={
              <Select
                value={String(preferences.evidenceRetentionDays)}
                disabled={saving || !preferences.archiveEvidence}
                onValueChange={(value) =>
                  void save({ evidenceRetentionDays: Number(value) }, `Archived bundles kept for ${value} days.`)
                }
              >
                <SelectTrigger id="pref-retention" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {retentionOptions(preferences.evidenceRetentionDays).map((days) => (
                    <SelectItem key={days} value={String(days)}>
                      {days} days
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            htmlFor="pref-measurement-change"
            title="Notify on measurement change"
            description="Tell me when an endpoint publishes different measurements, so I can re-pin the digest in my Gatekeeper."
            control={
              <Switch
                id="pref-measurement-change"
                checked={preferences.notifyOnMeasurementChange}
                disabled={saving}
                onCheckedChange={(checked) =>
                  void save(
                    { notifyOnMeasurementChange: checked },
                    checked ? 'You will be notified of measurement changes.' : 'Measurement-change alerts off.',
                  )
                }
              />
            }
          />
        </Card>

        <ExportEvidenceCard workspaceId={activeWorkspace?.id ?? null} />
      </div>
    </>
  );
}

/**
 * The offered windows, plus whatever is stored if it is not one of them — the
 * API accepts any value from 1 to 3650, and a select that could not show the
 * stored one would silently misreport the setting.
 */
function retentionOptions(stored: number): number[] {
  const options = new Set<number>(RETENTION_OPTIONS);
  options.add(stored);
  return [...options].sort((a, b) => a - b);
}
