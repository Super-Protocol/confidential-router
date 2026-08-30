import { Skeleton } from '@confidential-router/ui/components/skeleton';

export default function ConsoleLoading() {
  return (
    <div className="space-y-6" role="status" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {['a', 'b', 'c', 'd'].map((key) => (
          <Skeleton key={key} className="h-32" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}
