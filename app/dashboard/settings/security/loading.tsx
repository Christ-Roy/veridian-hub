import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/settings/security — mime header + section MFA toggle
 * + section password reset.
 */
export default function SecurityLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      {/* MFA toggle */}
      <div className="rounded-lg border bg-card p-6 mb-6 space-y-4">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full max-w-lg" />
        <div className="flex items-center justify-between pt-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-6 w-11 rounded-full" />
        </div>
      </div>

      {/* Password reset */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-10 w-48" />
      </div>
    </div>
  );
}
