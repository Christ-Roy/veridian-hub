import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/admin/tenants — mime header + table de tenants
 * (7 colonnes : email, workspace, plan, status, Notifuse, Prospection, actions).
 */
export default function AdminTenantsLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-8" />

      <div className="rounded-lg border bg-card overflow-hidden">
        {/* Header table */}
        <div className="grid grid-cols-7 gap-4 p-4 border-b bg-muted/40">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
        {/* Rows */}
        <div className="divide-y">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((row) => (
            <div key={row} className="grid grid-cols-7 gap-4 p-4 items-center">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-4 w-full" />
              ))}
              <Skeleton className="h-8 w-20 justify-self-end" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
