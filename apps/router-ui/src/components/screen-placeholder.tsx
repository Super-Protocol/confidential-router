import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { Construction } from 'lucide-react';
import { PageHeader } from './page-header';

export interface ScreenPlaceholderProps {
  title: string;
  description: string;
  /** The Multica issue that builds this screen, e.g. `SUP-79`. */
  issue: string;
}

/**
 * Stands in for a screen the shell can already route to but that a later issue
 * builds (SUP-78 … SUP-81). It names the issue rather than saying "coming soon",
 * so an empty page is traceable to the work that fills it.
 */
export function ScreenPlaceholder({ title, description, issue }: ScreenPlaceholderProps) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={<Construction className="size-5" aria-hidden="true" />}
        title="This screen is not built yet"
        description={<>Tracked by {issue}. The shell, tokens and data layer it will sit on are in place.</>}
      />
    </>
  );
}
