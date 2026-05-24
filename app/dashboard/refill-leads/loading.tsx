import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/refill-leads — mime header + 2 Cards (grille tarifaire + form).
 */
export default function RefillLeadsLoading() {
  return (
    <div className="flex flex-col gap-8 p-4 md:p-8 max-w-4xl mx-auto w-full">
      <PageHeaderSkeleton />

      <div className="grid gap-6">
        {/* Pricing grid card */}
        <div className="rounded-lg border bg-card p-6 space-y-3">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-80" />
          <div className="space-y-2 pt-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex justify-between py-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </div>
        </div>

        {/* Form card */}
        <div className="rounded-lg border bg-card p-6 space-y-6">
          <Skeleton className="h-6 w-72" />
          <Skeleton className="h-4 w-80" />
          <div className="flex items-center gap-4">
            <Skeleton className="h-2 flex-1 rounded-full" />
            <Skeleton className="h-10 w-32" />
          </div>
          <div className="space-y-3 rounded-lg border bg-muted/20 p-6">
            <Skeleton className="h-4 w-24 mx-auto" />
            <Skeleton className="h-10 w-48 mx-auto" />
            <Skeleton className="h-8 w-36 mx-auto" />
          </div>
          <Skeleton className="h-12 w-full" />
        </div>
      </div>
    </div>
  );
}
