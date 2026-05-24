import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/workspace/members — mime header + invite form +
 * liste de membres.
 */
export default function MembersLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      {/* Invite form */}
      <div className="rounded-lg border bg-card p-6 mb-6 space-y-3">
        <Skeleton className="h-5 w-48" />
        <div className="flex gap-2">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-32" />
        </div>
      </div>

      {/* Members list */}
      <div className="rounded-lg border bg-card divide-y">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="space-y-1">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
            <Skeleton className="h-8 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
