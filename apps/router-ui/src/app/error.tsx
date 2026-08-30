'use client';

import { ErrorState } from '@confidential-router/ui/components/error-state';
import * as React from 'react';

/**
 * Route-level error boundary. Shows the digest, never the message: in a
 * production build the message is stripped anyway, and in development it can
 * carry a query or an API response the viewer should not read off the page.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto max-w-xl py-10">
      <ErrorState onRetry={reset} detail={error.digest ? `digest ${error.digest}` : undefined} />
    </div>
  );
}
