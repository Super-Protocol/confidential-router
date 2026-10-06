import { cn } from '@confidential-router/ui/lib/utils';
import { Eye } from 'lucide-react';

/**
 * Why a signed-in non-admin is standing on an admin screen and seeing no
 * buttons.
 *
 * ADR-008 §7 and ruling 3 make this a product decision rather than a leniency:
 * *"an operator curating external capacity in secret is the configuration this
 * product should make impossible to sell as confidential."* So these screens
 * read for every signed-in member and mutate for nobody else — the nav entry is
 * admin-only (there is nothing here a member needs routinely), the API scopes
 * the credential fields away, and the refusal a non-admin would get from a
 * mutation is never provoked, because the mutation is never offered.
 */
export function AdminReadOnlyNotice({ className }: { className?: string }) {
  return (
    <div
      role="note"
      className={cn('flex gap-3 rounded-lg border bg-muted/40 px-4 py-3 text-sm', className)}
      data-testid="admin-read-only-notice"
    >
      <Eye className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Read-only.</span> Registering an upstream and editing the trust
        list are administrator actions. Everything that decides what this router will proxy is shown here on purpose —
        who is trusted should not be a private fact about the operator.
      </p>
    </div>
  );
}
