import { PageHeaderSkeleton } from '@/components/dashboard/PageHeaderSkeleton';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading state /dashboard/admin/lookup — mime header + form.
 */
export default function AdminLookupLoading() {
  return (
    <div>
      <PageHeaderSkeleton className="mb-6" />
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-full" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
    </div>
  );
}
