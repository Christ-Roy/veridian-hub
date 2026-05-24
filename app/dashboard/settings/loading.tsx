import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/settings — mime header + sections form profil.
 */
export default function SettingsLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      <div className="space-y-6">
        {[0, 1, 2].map((section) => (
          <div key={section} className="rounded-lg border bg-card p-6 space-y-4">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-full max-w-lg" />
            <div className="space-y-3 pt-2">
              {[0, 1].map((i) => (
                <div key={i} className="space-y-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-10 w-full max-w-md" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
