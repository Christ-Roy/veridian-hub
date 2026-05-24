import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/billing — mime header + status alert + SubscriptionCard.
 * Évite le flash blanc pendant fetch Stripe customer + subscriptions.
 */
export default function BillingLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      {/* Status alert */}
      <Skeleton className="h-14 w-full mb-6 rounded-lg" />

      {/* Subscription card */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-6 w-20 rounded-full" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-5 w-32" />
            </div>
          ))}
        </div>
        <div className="pt-4 flex gap-2">
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-10 w-32" />
        </div>
      </div>
    </div>
  );
}
