import { BrandMark } from '../../components/brand-mark';

/**
 * The signed-out shell: no sidebar, no session query, no workspace. Kept in its
 * own route group so nothing under `(console)` can accidentally render here.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 py-12">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-brand-foreground">
          <BrandMark className="size-[18px]" />
        </span>
        <div className="flex flex-col">
          <span className="font-semibold text-sm leading-tight">Confidential Router</span>
          <span className="font-mono text-[0.65rem] text-muted-foreground leading-tight">confidential inference</span>
        </div>
      </div>
      <main id="main-content" className="w-full max-w-sm">
        {children}
      </main>
      <p className="max-w-sm text-center text-muted-foreground text-xs leading-relaxed">
        Prompts are metered, never stored. Evidence for every endpoint is published at{' '}
        <code className="font-mono">/.well-known/swarm-evidence</code>.
      </p>
    </div>
  );
}
