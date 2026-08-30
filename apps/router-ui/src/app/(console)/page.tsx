import { Button } from '@confidential-router/ui/components/button';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { Construction } from 'lucide-react';
import Link from 'next/link';
import { BrandMark } from '../../components/brand-mark';
import { PageHeader } from '../../components/page-header';

/**
 * The landing screen. Its metrics — spend, requests, tokens, evidence coverage —
 * are built in SUP-78 on top of `activitySummary` and `endpoints`. What is here
 * is the part that belongs to the shell: the product's claim, and the one action
 * that follows from it.
 */
export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Every model here runs inside a TEE and returns signed evidence with each response. Verify it yourself with Gatekeeper, or don't — the endpoint works either way."
      />

      <div className="mb-6 flex flex-col gap-3.5 rounded-xl border border-brand-border bg-brand-muted px-4 py-3.5 sm:flex-row sm:items-center">
        <BrandMark className="size-[18px] shrink-0 text-brand-emphasis" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">Attestation is yours to check, not ours to claim</p>
          <p className="text-muted-foreground text-sm leading-relaxed">
            The router publishes evidence and never learns whether anyone verified it. Run Gatekeeper on your side and
            it checks the enclave before your prompt leaves your machine.
          </p>
        </div>
        <Button variant="outline" size="sm" asChild className="w-full sm:w-auto">
          <Link href="/gatekeeper">How it works</Link>
        </Button>
      </div>

      <EmptyState
        icon={<Construction className="size-5" aria-hidden="true" />}
        title="Usage metrics land with SUP-78"
        description="Spend, requests, tokens and evidence coverage render here once the Overview queries exist."
      />
    </>
  );
}
