import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/admin/analytics — mime header + tenant panels
 * (formulaires create tenant / create site / attach GSC).
 */
export default function AdminAnalyticsLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      <div className="space-y-6">
        {[0, 1, 2].map((panel) => (
          <div key={panel} className="rounded-lg border bg-card p-6 space-y-4">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-full max-w-lg" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
            <Skeleton className="h-10 w-40" />
          </div>
        ))}
      </div>
    </div>
  );
}
