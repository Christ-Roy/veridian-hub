import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/admin — mime header + grille de cards admin.
 */
export default function AdminLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border bg-card p-6 space-y-3">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-9 w-full mt-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
