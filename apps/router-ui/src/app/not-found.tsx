import { Button } from '@confidential-router/ui/components/button';
import { EmptyState } from '@confidential-router/ui/components/empty-state';
import { FileQuestion } from 'lucide-react';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl py-20">
      <EmptyState
        icon={<FileQuestion className="size-5" aria-hidden="true" />}
        title="Page not found"
        description="That URL does not match any console screen."
        action={
          <Button asChild size="sm" variant="outline">
            <Link href="/">Back to Overview</Link>
          </Button>
        }
      />
    </div>
  );
}
