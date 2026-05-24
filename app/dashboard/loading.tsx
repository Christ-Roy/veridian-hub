import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard — mime header + onboarding checklist + 2 grilles
 * de cards (SaaS apps + services suivi). Évite le flash blanc pendant les
 * fetch Prisma + tenant/subscription cross-app.
 */
export default function DashboardLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      {/* Onboarding checklist */}
      <div className="mb-8 rounded-lg border bg-card p-6 space-y-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
        <div className="space-y-2 pt-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="h-5 w-5 rounded-full" />
              <Skeleton className="h-4 w-64" />
            </div>
          ))}
        </div>
      </div>

      {/* Section SaaS apps */}
      <section className="mb-12">
        <div className="mb-4 space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-lg border bg-card p-6 space-y-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded" />
                <Skeleton className="h-5 w-32" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      </section>

      {/* Section services de suivi */}
      <section>
        <div className="mb-4 space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="rounded-lg border bg-card p-6 space-y-4">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded" />
                <Skeleton className="h-5 w-40" />
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-9 w-32" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
