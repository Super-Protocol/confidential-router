import { Button } from '@confidential-router/ui/components/button';
import Link from 'next/link';
import { BrandMark } from '../../components/brand-mark';
import { OverviewScreen } from '../../components/overview/overview-screen';
import { PageHeader } from '../../components/page-header';

const SHORTCUTS = [
  { href: '/keys', title: 'API Keys', description: 'Issue keys, scope them to models, cap spend per key.' },
  { href: '/models', title: 'Models', description: 'What this router serves, from which endpoint, at what price.' },
  {
    href: '/logs',
    title: 'Logs',
    description: 'Metered generations per key. Prompt content never leaves the enclave.',
  },
];

/**
 * The landing screen: the product's claim, this week's numbers, and the
 * endpoints behind them. Everything with data in it lives in `OverviewScreen`,
 * which is a client component because the workspace it is scoped to comes from
 * the session in the browser.
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

      <OverviewScreen />

      <div className="mt-6 grid gap-3.5 sm:grid-cols-3">
        {SHORTCUTS.map((shortcut) => (
          <Link
            key={shortcut.href}
            href={shortcut.href}
            className="rounded-xl border bg-card px-4 py-3.5 text-card-foreground shadow-sm transition-colors hover:border-ring"
          >
            <p className="font-medium text-sm">{shortcut.title}</p>
            <p className="mt-1 text-muted-foreground text-sm leading-relaxed">{shortcut.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
